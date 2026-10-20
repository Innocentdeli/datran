//! Online, consistent backups and verified restores (NETWORK_SPEC §2 "Backup & restore").
//!
//! [`Store::backup`] runs while the reactor serves traffic:
//! 1. it takes the store's maintenance gate exclusively (waits for a running GC / repair, then
//!    makes GC, retired-pack deletion, quarantine moves and repair installs skip or defer their
//!    work until it finishes — writes, reads and pack appends continue normally);
//! 2. opens one redb read transaction (a consistent snapshot) and copies every index table into a
//!    fresh `store/index.redb` in the destination;
//! 3. copies what the snapshot references: each pack listed in the snapshot **up to its committed
//!    end** (packs are append-only below it), each non-quarantined file object, and the state-dir
//!    files (`state.json`, `node_id`, `cluster-leases.json`, `dicts/*.dict`);
//! 4. writes `MANIFEST.json` last (its presence marks a complete backup) with the SHA-256 and size
//!    of every file.
//!
//! **Incremental**: with a previous backup, a file object with the same id, size and key slot (the
//! stored bytes of an object only change through rekey / repair, which change the slot or the
//! size, and any such copy decrypts and decodes to the same plaintext) and a pack with the same id
//! and committed length are not copied; the manifest entry points at the backup that holds the
//! bytes (`base`, always the backup that physically has them, so chains never get longer than one
//! hop). Keep the base backups as long as backups that reference them.
//!
//! **Encryption**: stored bytes are copied as they are (ciphertext when encryption at rest is on);
//! master keys are never part of a backup. The manifest lists the key ids in use and restore
//! refuses to start unless every one of them is configured.
//!
//! [`restore`] copies every file into an empty state dir while checking its SHA-256 against the
//! manifest, then opens the restored store and runs the deep fsck (decrypt + decode + hash of
//! every object); any failure removes what was restored and returns an error.

use super::index::{self, meta, ObjectRec};
use super::{id_hex, Id, Result, Store, StoreError};
use redb::{Database, ReadableDatabase, TableDefinition};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const MANIFEST: &str = "MANIFEST.json";
pub const BACKUP_FORMAT: u32 = 1;
/// State-dir files that belong to a node (besides `dicts/` and the store).
const STATE_FILES: &[&str] = &["state.json", "node_id", "cluster-leases.json"];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    /// Relative path inside the backup / state dir, `/`-separated.
    pub path: String,
    pub size: u64,
    pub sha256: String,
    /// Backup directory that physically holds the bytes when it is not this one (incremental).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base: Option<String>,
    /// Key slot of an object file (for incremental matching).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_slot: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BackupManifest {
    pub format: u32,
    pub created_ms: u64,
    pub reactor_version: String,
    /// The previous backup this one was taken against (informational).
    #[serde(default)]
    pub previous: Option<String>,
    pub encryption: EncryptionInfo,
    pub index: IndexSummary,
    pub files: Vec<FileEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct EncryptionInfo {
    /// Key ids that stored objects or dictionaries are sealed under (keys are NOT in the backup).
    pub key_ids: Vec<String>,
    pub plaintext_objects: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct IndexSummary {
    pub files: u64,
    pub objects: u64,
    pub logical_bytes: u64,
    pub physical_bytes: u64,
    pub packs: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BackupReport {
    pub dest: String,
    pub files: u64,
    pub bytes_total: u64,
    /// Bytes written into this backup directory.
    pub bytes_copied: u64,
    pub objects_copied: u64,
    pub objects_reused: u64,
    pub packs_copied: u64,
    pub packs_reused: u64,
    pub key_ids: Vec<String>,
    pub seconds: f64,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct RestoreReport {
    pub files: u64,
    pub bytes: u64,
    pub fsck: Option<super::ConsistencyReport>,
    pub seconds: f64,
}

fn io_err(what: impl std::fmt::Display, e: std::io::Error) -> StoreError {
    StoreError::Io(std::io::Error::new(e.kind(), format!("{}: {}", what, e)))
}

/// Streams `len` bytes (or everything with `None`) of `src` into a new file `dst` (fsynced),
/// returning `(bytes, sha256)`.
fn copy_hashed(src: &Path, dst: &Path, len: Option<u64>) -> Result<(u64, String)> {
    if let Some(d) = dst.parent() {
        std::fs::create_dir_all(d).map_err(|e| io_err(d.display(), e))?;
    }
    let f = std::fs::File::open(src).map_err(|e| io_err(src.display(), e))?;
    let mut r: Box<dyn Read> = match len {
        Some(n) => Box::new(f.take(n)),
        None => Box::new(f),
    };
    let mut out = std::fs::File::create(dst).map_err(|e| io_err(dst.display(), e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = r.read(&mut buf).map_err(|e| io_err(src.display(), e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        out.write_all(&buf[..n])
            .map_err(|e| io_err(dst.display(), e))?;
        total += n as u64;
    }
    if let Some(n) = len {
        if total != n {
            return Err(StoreError::Corrupt(format!(
                "{}: {} bytes, expected {}",
                src.display(),
                total,
                n
            )));
        }
    }
    out.sync_all().map_err(|e| io_err(dst.display(), e))?;
    Ok((total, hex::encode(h.finalize())))
}

fn hash_file(p: &Path) -> Result<(u64, String)> {
    let mut f = std::fs::File::open(p).map_err(|e| io_err(p.display(), e))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    let mut total = 0u64;
    loop {
        let n = f.read(&mut buf).map_err(|e| io_err(p.display(), e))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, hex::encode(h.finalize())))
}

fn write_bytes(dst: &Path, bytes: &[u8]) -> Result<(u64, String)> {
    if let Some(d) = dst.parent() {
        std::fs::create_dir_all(d)?;
    }
    let mut f = std::fs::File::create(dst).map_err(|e| io_err(dst.display(), e))?;
    f.write_all(bytes)?;
    f.sync_all()?;
    Ok((bytes.len() as u64, hex::encode(Sha256::digest(bytes))))
}

pub(crate) fn rel_join(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |p, s| p.join(s))
}

/// A relative manifest path must stay inside its root (no absolute paths, no `..`).
pub(crate) fn safe_rel(rel: &str) -> bool {
    !rel.is_empty()
        && !rel.starts_with('/')
        && !rel.contains('\\')
        && !rel.contains(':')
        && rel
            .split('/')
            .all(|s| !s.is_empty() && s != "." && s != "..")
}

pub fn read_manifest(dir: &Path) -> Result<BackupManifest> {
    let b = std::fs::read(dir.join(MANIFEST)).map_err(|e| {
        io_err(
            format!("{} (not a complete backup?)", dir.join(MANIFEST).display()),
            e,
        )
    })?;
    let m: BackupManifest = serde_json::from_slice(&b)
        .map_err(|e| StoreError::Corrupt(format!("unreadable backup manifest: {}", e)))?;
    if m.format != BACKUP_FORMAT {
        return Err(StoreError::Invalid(format!(
            "unsupported backup format {}",
            m.format
        )));
    }
    for f in &m.files {
        if !safe_rel(&f.path) {
            return Err(StoreError::Corrupt(format!(
                "backup manifest has an unsafe path {:?}",
                f.path
            )));
        }
    }
    Ok(m)
}

fn dir_is_empty(p: &Path) -> bool {
    match std::fs::read_dir(p) {
        Ok(mut rd) => rd.next().is_none(),
        Err(_) => true,
    }
}

fn copy_table<K: redb::Key + 'static, V: redb::Value + 'static>(
    src: &redb::ReadTransaction,
    dst: &redb::WriteTransaction,
    def: TableDefinition<K, V>,
) -> Result<()> {
    let s = src.open_table(def)?;
    let mut d = dst.open_table(def)?;
    for r in s.range::<K::SelfType<'_>>(..)? {
        let (k, v) = r?;
        d.insert(k.value(), v.value())?;
    }
    Ok(())
}

impl Store {
    /// Online backup into `dest` (must not exist or be empty); `previous` = an earlier backup to
    /// take an incremental backup against. See the module docs.
    pub fn backup(&self, dest: &Path, previous: Option<&Path>) -> Result<BackupReport> {
        let r = self.backup_inner(dest, previous);
        crate::metrics::backup_done(r.is_ok());
        r
    }

    fn backup_inner(&self, dest: &Path, previous: Option<&Path>) -> Result<BackupReport> {
        let start = std::time::Instant::now();
        if !dir_is_empty(dest) {
            return Err(StoreError::Invalid(format!(
                "backup destination {} is not empty",
                dest.display()
            )));
        }
        let prev = match previous {
            Some(p) => {
                let m = read_manifest(p)?;
                let abs = std::fs::canonicalize(p)?;
                Some((abs, m))
            }
            None => None,
        };
        std::fs::create_dir_all(dest)?;
        let dest_abs = std::fs::canonicalize(dest)?;
        let inside = |p: &Path| std::fs::canonicalize(p).is_ok_and(|p| dest_abs.starts_with(p));
        if inside(self.dir()) || inside(&self.engine.cfg.state_dir) {
            return Err(StoreError::Invalid(
                "backup destination must be outside the reactor state dir".into(),
            ));
        }
        // previous entries by path, resolved to the directory that physically holds them
        let prev_by_path: HashMap<String, (FileEntry, String)> = match &prev {
            Some((abs, m)) => m
                .files
                .iter()
                .map(|f| {
                    let holder = f
                        .base
                        .clone()
                        .unwrap_or_else(|| abs.to_string_lossy().to_string());
                    (f.path.clone(), (f.clone(), holder))
                })
                .collect(),
            None => HashMap::new(),
        };

        // 1. exclusive maintenance gate: nothing deletes / moves / rewrites files from now on
        let _gate = self.maint_gate.write().unwrap_or_else(|p| p.into_inner());
        // 2. snapshot + index copy
        let tx = self.db.begin_read()?;
        let mut files: Vec<FileEntry> = Vec::new();
        let mut rep = BackupReport {
            dest: dest_abs.to_string_lossy().to_string(),
            ..Default::default()
        };
        {
            let idx_path = dest.join("store").join("index.redb");
            std::fs::create_dir_all(dest.join("store"))?;
            let out = Database::create(&idx_path)?;
            let w = out.begin_write()?;
            copy_table(&tx, &w, index::MANIFESTS)?;
            copy_table(&tx, &w, index::MANIFEST_CHUNKS)?;
            copy_table(&tx, &w, index::CHUNK_LOC)?;
            copy_table(&tx, &w, index::OBJECTS)?;
            copy_table(&tx, &w, index::PINS)?;
            copy_table(&tx, &w, index::TOMBSTONES)?;
            copy_table(&tx, &w, index::ACCESS)?;
            copy_table(&tx, &w, index::GC_QUEUE)?;
            copy_table(&tx, &w, index::QUARANTINE)?;
            copy_table(&tx, &w, index::FILE_LOG)?;
            copy_table(&tx, &w, index::META)?;
            copy_table(&tx, &w, index::PACKS)?;
            w.commit()?;
            drop(out);
            let (size, sha) = hash_file(&idx_path)?;
            rep.bytes_copied += size;
            files.push(FileEntry {
                path: "store/index.redb".into(),
                size,
                sha256: sha,
                base: None,
                key_slot: None,
            });
        }

        // snapshot counters and key slots (for the encryption section)
        let mut meta_map: HashMap<String, u64> = HashMap::new();
        for r in tx.open_table(index::META)?.range::<&str>(..)? {
            let (k, v) = r?;
            meta_map.insert(k.value().to_string(), v.value());
        }
        let slot_names: HashMap<u8, String> = meta_map
            .iter()
            .filter_map(|(k, v)| {
                k.strip_prefix(meta::KEY_SLOT_PREFIX)
                    .map(|id| (*v as u8, id.to_string()))
            })
            .collect();

        let reuse = |path: &str, size: u64, slot: Option<u8>| -> Option<FileEntry> {
            let (e, holder) = prev_by_path.get(path)?;
            (e.size == size && e.key_slot == slot).then(|| FileEntry {
                base: Some(holder.clone()),
                ..e.clone()
            })
        };

        // 3a. packs, up to their committed end
        let mut packs = 0u64;
        for r in tx.open_table(index::PACKS)?.range::<u64>(..)? {
            let (k, v) = r?;
            let (pid, row) = (k.value(), index::PackRec::decode(v.value())?);
            packs += 1;
            let rel = format!("store/packs/{:016x}.pack", pid);
            if let Some(e) = reuse(&rel, row.end, None) {
                rep.packs_reused += 1;
                files.push(e);
                continue;
            }
            let (size, sha) =
                copy_hashed(&self.pack_path(pid), &rel_join(dest, &rel), Some(row.end))?;
            rep.bytes_copied += size;
            rep.packs_copied += 1;
            files.push(FileEntry {
                path: rel,
                size,
                sha256: sha,
                base: None,
                key_slot: None,
            });
        }
        // 3b. file objects (packed and quarantined ones have no file to copy)
        let mut objects = 0u64;
        for r in tx.open_table(index::OBJECTS)?.range::<&[u8; 32]>(..)? {
            let (k, v) = r?;
            let id: Id = *k.value();
            let rec = ObjectRec::decode(v.value())?;
            objects += 1;
            if rec.pack.is_some() || rec.quarantined() {
                continue;
            }
            let h = id_hex(&id);
            let rel = format!("store/objects/{}/{}.obj", &h[..2], h);
            let slot = Some(rec.key_slot());
            if let Some(e) = reuse(&rel, rec.stored_len, slot) {
                rep.objects_reused += 1;
                files.push(e);
                continue;
            }
            let (size, sha) = copy_hashed(
                &self.object_path(&id),
                &rel_join(dest, &rel),
                Some(rec.stored_len),
            )
            .map_err(|e| StoreError::Corrupt(format!("object {}: {}", h, e)))?;
            rep.bytes_copied += size;
            rep.objects_copied += 1;
            files.push(FileEntry {
                path: rel,
                size,
                sha256: sha,
                base: None,
                key_slot: slot,
            });
        }
        drop(tx);

        // 3c. node state: evolution state, node id, leases, dictionaries
        let state_dir = self.engine.cfg.state_dir.clone();
        let mut state_rel: Vec<String> = STATE_FILES.iter().map(|s| s.to_string()).collect();
        if let Ok(rd) = std::fs::read_dir(state_dir.join("dicts")) {
            let mut names: Vec<String> = rd
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.ends_with(".dict"))
                .collect();
            names.sort();
            state_rel.extend(names.into_iter().map(|n| format!("dicts/{}", n)));
        }
        for rel in state_rel {
            // read whole (small, atomically replaced files) so the copy is one consistent version
            let Ok(bytes) = std::fs::read(rel_join(&state_dir, &rel)) else {
                continue;
            };
            let (size, sha) = write_bytes(&rel_join(&dest.join("state"), &rel), &bytes)?;
            rep.bytes_copied += size;
            files.push(FileEntry {
                path: format!("state/{}", rel),
                size,
                sha256: sha,
                base: None,
                key_slot: None,
            });
        }

        // 4. manifest
        let mut key_ids: Vec<String> = meta_map
            .iter()
            .filter_map(|(k, n)| {
                k.strip_prefix(meta::ENC_OBJECTS_PREFIX)
                    .and_then(|s| s.parse::<u8>().ok())
                    .filter(|s| *s != 0 && *n > 0)
            })
            .map(|s| {
                slot_names
                    .get(&s)
                    .cloned()
                    .unwrap_or_else(|| format!("slot-{}", s))
            })
            .collect();
        for d in self.engine.dicts.list_ids() {
            if let Some(k) = self.engine.dicts.file_key_id(&d) {
                key_ids.push(k);
            }
        }
        key_ids.sort();
        key_ids.dedup();
        let g = |k: &str| meta_map.get(k).copied().unwrap_or(0);
        let manifest = BackupManifest {
            format: BACKUP_FORMAT,
            created_ms: super::now(),
            reactor_version: env!("CARGO_PKG_VERSION").into(),
            previous: prev.as_ref().map(|p| p.0.to_string_lossy().to_string()),
            encryption: EncryptionInfo {
                key_ids: key_ids.clone(),
                plaintext_objects: g(&meta::enc_objects(0)),
            },
            index: IndexSummary {
                files: g(meta::FILES),
                objects,
                logical_bytes: g(meta::LOGICAL),
                physical_bytes: g(meta::PHYSICAL),
                packs,
            },
            files,
        };
        rep.files = manifest.files.len() as u64;
        rep.bytes_total = manifest.files.iter().map(|f| f.size).sum();
        rep.key_ids = key_ids;
        let body =
            serde_json::to_vec_pretty(&manifest).map_err(|e| StoreError::Invalid(e.to_string()))?;
        let tmp = dest.join(".MANIFEST.json.tmp");
        write_bytes(&tmp, &body)?;
        std::fs::rename(&tmp, dest.join(MANIFEST))?;
        rep.seconds = start.elapsed().as_secs_f64();
        tracing::info!(dest = %rep.dest, files = rep.files, copied_bytes = rep.bytes_copied, objects_reused = rep.objects_reused, "backup complete");
        Ok(rep)
    }
}

/// A base backup path as recorded by the reactor (e.g. `/backups/<name>` inside a container);
/// when it does not exist here, the sibling of `src` with the same directory name is used (backups
/// copied / mounted elsewhere together).
fn resolve_base(src: &Path, base: &str) -> PathBuf {
    let p = PathBuf::from(base);
    if p.join(MANIFEST).exists() {
        return p;
    }
    let name = base
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(base);
    match src.parent() {
        Some(parent) if !name.is_empty() => parent.join(name),
        _ => p,
    }
}

/// Key ids a backup needs that `keys` does not have.
pub fn missing_keys(m: &BackupManifest, keys: &crate::crypto::KeyRing) -> Vec<String> {
    m.encryption
        .key_ids
        .iter()
        .filter(|k| !keys.has_key(k))
        .cloned()
        .collect()
}

/// Restores backup `src` into `state_dir` (see the module docs). `state_dir` must be empty unless
/// `force` (then the reactor-owned entries in it are replaced). `open_and_verify` opens the
/// restored store and returns its deep fsck report (the caller builds the engine with the
/// configured keys); restore fails unless the report is clean.
pub fn restore(
    src: &Path,
    state_dir: &Path,
    force: bool,
    keys: &crate::crypto::KeyRing,
    open_and_verify: &dyn Fn(&Path) -> Result<super::ConsistencyReport>,
) -> Result<RestoreReport> {
    let start = std::time::Instant::now();
    let m = read_manifest(src)?;
    let missing = missing_keys(&m, keys);
    if !missing.is_empty() {
        return Err(StoreError::KeyUnavailable(format!(
            "the backup is encrypted under key id(s) {:?} which are not configured; set REACTOR_MASTER_KEYS / REACTOR_MASTER_KEY to the same master keys the source reactor used (keys are never included in a backup)",
            missing
        )));
    }
    if !dir_is_empty(state_dir) {
        if !force {
            return Err(StoreError::Invalid(format!(
                "restore target {} is not empty (use --force to replace its reactor state)",
                state_dir.display()
            )));
        }
        for e in ["store", "dicts"] {
            let p = state_dir.join(e);
            if p.exists() {
                std::fs::remove_dir_all(&p)?;
            }
        }
        for f in STATE_FILES {
            let _ = std::fs::remove_file(state_dir.join(f));
        }
    }
    std::fs::create_dir_all(state_dir)?;
    let mut written: Vec<PathBuf> = Vec::new();
    let res = (|| -> Result<RestoreReport> {
        let mut rep = RestoreReport::default();
        for f in &m.files {
            let holder = match &f.base {
                None => src.to_path_buf(),
                Some(b) => resolve_base(src, b),
            };
            let from = rel_join(&holder, &f.path);
            let to_rel = f.path.strip_prefix("state/").unwrap_or(&f.path);
            let to = rel_join(state_dir, to_rel);
            written.push(to.clone());
            let (size, sha) = copy_hashed(&from, &to, None)?;
            if size != f.size || sha != f.sha256 {
                return Err(StoreError::Corrupt(format!(
                    "backup file {} fails its manifest check (size {} / {}, sha256 {} / {})",
                    f.path, size, f.size, sha, f.sha256
                )));
            }
            rep.files += 1;
            rep.bytes += size;
        }
        for d in ["objects", "packs", "quarantine"] {
            std::fs::create_dir_all(state_dir.join("store").join(d))?;
        }
        let fsck = open_and_verify(state_dir)?;
        if !fsck.ok() {
            return Err(StoreError::Corrupt(format!(
                "restored store fails the deep check: {:?}",
                fsck.problems.iter().take(10).collect::<Vec<_>>()
            )));
        }
        rep.fsck = Some(fsck);
        rep.seconds = start.elapsed().as_secs_f64();
        Ok(rep)
    })();
    if res.is_err() {
        // never leave a half-restored state dir that a reactor could start on
        let _ = std::fs::remove_dir_all(state_dir.join("store"));
        let _ = std::fs::remove_dir_all(state_dir.join("dicts"));
        for p in written {
            let _ = std::fs::remove_file(p);
        }
    }
    res
}
