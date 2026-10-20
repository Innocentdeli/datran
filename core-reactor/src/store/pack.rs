//! Append-only pack files for small objects (NETWORK_SPEC §2 "Pack files"), in the spirit of git
//! packfiles / Facebook Haystack.
//!
//! Objects whose stored (compressed) size is below `REACTOR_PACK_THRESHOLD` (default 128 KiB) are
//! appended as self-describing records to the active pack `packs/<pack_id:016x>.pack` instead of
//! getting a file each; the index stores `(pack_id, offset)`. A group-commit batch appends every
//! writer's records with ONE write + ONE fsync and then commits ONE redb transaction, so a small
//! upload no longer pays `fsync + rename` per object. Durability is unchanged: a PUT is
//! acknowledged only after its pack bytes were fsynced and its index transaction committed.
//!
//! Format (little-endian):
//! - pack header (16 bytes): magic `DTRPACK1`, `pack_id u64`
//! - record: `magic u32 = "REC1"`, `object_id [32]`, `len u32`, `crc32 u32` (CRC-32/IEEE over
//!   `object_id ‖ len ‖ payload`), then `payload[len]` (the blob-v2 object, exactly as a file object
//!   would hold it).
//!
//! Crash safety: every transaction that indexes a packed record also raises the pack's committed
//! `end` (index table `packs`) to cover it, and the record was fsynced before that commit. On
//! startup each pack is truncated to its committed `end` (torn / uncommitted tail); pack files
//! without an index row (crash before their first commit, or a compacted pack awaiting deletion)
//! are removed. Records below `end` that no index row points at are just garbage (dead bytes).
//!
//! Compaction: a sealed pack (not the active one) whose live bytes fall below
//! `pack_compact_ratio` (50 %) of its data has its live records copied into the active pack
//! (copy → fsync → one index transaction repointing each object that still lives at the old
//! location), then its row is removed and the file is deleted after a grace period. Readers that
//! raced with the move either still read the old (immutable) record or re-resolve the location
//! and retry. Appends pin the packs they touched until the caller's index commit, and only the
//! active pack ever receives appends, so a compaction never retires a pack with uncommitted records.

use super::index::{self, meta, PackLoc, PackRec};
use super::{lock, now, with_write, Id, Result, Store, StoreError};
use redb::ReadableDatabase;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{File, OpenOptions};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub const PACK_MAGIC: &[u8; 8] = b"DTRPACK1";
pub const PACK_HEADER: u64 = 16;
pub const RECORD_MAGIC: u32 = u32::from_le_bytes(*b"REC1");
pub const RECORD_HEADER: u64 = 44;
/// Default `REACTOR_PACK_THRESHOLD`.
pub const DEFAULT_THRESHOLD: usize = 128 * 1024;
/// Default `REACTOR_PACK_MAX_BYTES`.
pub const DEFAULT_MAX_BYTES: u64 = 256 << 20;
/// Bounded cache of open read handles.
const HANDLE_CACHE: usize = 64;
/// Compaction copies live records in batches of about this many bytes.
const COMPACT_BATCH: u64 = 16 << 20;

/// On-disk size of a record holding `stored_len` payload bytes.
pub fn record_size(stored_len: u64) -> u64 {
    RECORD_HEADER + stored_len
}

fn record_crc(id: &Id, payload: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(id);
    h.update(&(payload.len() as u32).to_le_bytes());
    h.update(payload);
    h.finalize()
}

pub fn encode_record(id: &Id, payload: &[u8], out: &mut Vec<u8>) {
    out.reserve(record_size(payload.len() as u64) as usize);
    out.extend_from_slice(&RECORD_MAGIC.to_le_bytes());
    out.extend_from_slice(id);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&record_crc(id, payload).to_le_bytes());
    out.extend_from_slice(payload);
}

/// Checks a whole record (header + payload) against the object id it should hold.
pub fn check_record(id: &Id, rec: &[u8]) -> std::result::Result<(), String> {
    let h = RECORD_HEADER as usize;
    if rec.len() < h {
        return Err("pack record truncated".into());
    }
    let u32_at = |at: usize| u32::from_le_bytes([rec[at], rec[at + 1], rec[at + 2], rec[at + 3]]);
    if u32_at(0) != RECORD_MAGIC {
        return Err("pack record has a bad magic".into());
    }
    if rec[4..36] != id[..] {
        return Err("pack record holds a different object".into());
    }
    if u32_at(36) as usize != rec.len() - h {
        return Err(format!(
            "pack record length {} != index {}",
            u32_at(36),
            rec.len() - h
        ));
    }
    if u32_at(40) != record_crc(id, &rec[h..]) {
        return Err("pack record CRC mismatch".into());
    }
    Ok(())
}

#[cfg(unix)]
fn read_exact_at(f: &File, buf: &mut [u8], off: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(f, buf, off)
}

#[cfg(windows)]
fn read_exact_at(f: &File, buf: &mut [u8], off: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0usize;
    while done < buf.len() {
        let n = f.seek_read(&mut buf[done..], off + done as u64)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "pack ends inside the record",
            ));
        }
        done += n;
    }
    Ok(())
}

#[cfg(unix)]
fn write_all_at(f: &File, buf: &[u8], off: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::write_all_at(f, buf, off)
}

#[cfg(windows)]
fn write_all_at(f: &File, buf: &[u8], off: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    let mut done = 0usize;
    while done < buf.len() {
        let n = f.seek_write(&buf[done..], off + done as u64)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::WriteZero,
                "pack write returned 0",
            ));
        }
        done += n;
    }
    Ok(())
}

#[derive(Default)]
struct Writer {
    /// Active pack (the only one that receives appends) and its write position.
    active: Option<(u64, Arc<File>)>,
    len: u64,
    next_id: u64,
}

#[derive(Default)]
struct Handles {
    map: HashMap<u64, (Arc<File>, u64)>,
    tick: u64,
}

/// Pack state of one store.
#[derive(Default)]
pub(crate) struct Packs {
    writer: Mutex<Writer>,
    handles: Mutex<Handles>,
    /// Packs with appended records whose index transaction has not finished yet.
    inflight: Mutex<HashMap<u64, u32>>,
    /// Compacted packs (row removed) to delete after the grace period: `(pack_id, due_ms)`.
    retired: Mutex<Vec<(u64, u64)>>,
    compact_lock: Mutex<()>,
    pub rotations: AtomicU64,
    pub appends: AtomicU64,
    pub fsyncs: AtomicU64,
    pub startup_truncated_bytes: AtomicU64,
    pub startup_removed_packs: AtomicU64,
}

/// Keeps the packs an append touched from being retired until the appender's index transaction
/// finished (committed or failed). Released on drop.
pub(crate) struct PackPin<'a> {
    store: &'a Store,
    packs: Vec<u64>,
}

impl PackPin<'_> {
    pub fn absorb(&mut self, mut other: PackPin<'_>) {
        self.packs.append(&mut other.packs);
    }
}

impl<'a> PackPin<'a> {
    pub fn none(store: &'a Store) -> PackPin<'a> {
        PackPin {
            store,
            packs: Vec::new(),
        }
    }
}

impl Drop for PackPin<'_> {
    fn drop(&mut self) {
        if self.packs.is_empty() {
            return;
        }
        let mut m = lock(&self.store.packs.inflight);
        for p in self.packs.drain(..) {
            if let Some(c) = m.get_mut(&p) {
                *c -= 1;
                if *c == 0 {
                    m.remove(&p);
                }
            }
        }
    }
}

/// Where an object's stored bytes are on disk (tests use it to inject corruption).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ObjectStorage {
    pub path: PathBuf,
    /// Byte offset of the stored object (blob v2) inside `path`.
    pub offset: u64,
    pub len: u64,
    /// `Some(pack_id)` for a packed object.
    pub pack: Option<u64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CompactReport {
    /// Packs whose live records were moved and whose row was removed.
    pub packs_compacted: u64,
    pub objects_moved: u64,
    pub bytes_moved: u64,
    /// Committed bytes of the retired packs (released once their files are deleted).
    pub bytes_reclaimed: u64,
    pub retired_files_deleted: u64,
}

impl Store {
    pub(crate) fn pack_path(&self, pack: u64) -> PathBuf {
        self.cfg
            .dir
            .join("packs")
            .join(format!("{:016x}.pack", pack))
    }

    /// Whether a stored object of `len` bytes goes into a pack.
    pub(crate) fn pack_eligible(&self, len: usize) -> bool {
        len < self.cfg.pack_threshold
    }

    fn open_new_pack(&self, w: &mut Writer) -> Result<()> {
        let id = w.next_id.max(1);
        w.next_id = id + 1;
        let path = self.pack_path(id);
        let f = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        let mut hdr = [0u8; PACK_HEADER as usize];
        hdr[..8].copy_from_slice(PACK_MAGIC);
        hdr[8..].copy_from_slice(&id.to_le_bytes());
        write_all_at(&f, &hdr, 0)?;
        #[cfg(unix)]
        if let Some(d) = path.parent().and_then(|d| File::open(d).ok()) {
            let _ = d.sync_all();
        }
        w.active = Some((id, Arc::new(f)));
        w.len = PACK_HEADER;
        self.packs.rotations.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    /// Appends records to the active pack (rotating at `pack_max_bytes`) with one write per pack
    /// segment, then fsyncs every pack written. Returns each record's location and a pin that the
    /// caller must hold until its index transaction has finished.
    pub(crate) fn pack_append(&self, items: &[(Id, &[u8])]) -> Result<(Vec<PackLoc>, PackPin<'_>)> {
        let mut pin = PackPin::none(self);
        if items.is_empty() {
            return Ok((Vec::new(), pin));
        }
        let max = self.cfg.pack_max_bytes.max(PACK_HEADER + 1);
        let mut locs = Vec::with_capacity(items.len());
        let mut touched: Vec<Arc<File>> = Vec::new();
        {
            let mut w = lock(&self.packs.writer);
            let mut i = 0;
            while i < items.len() {
                let need = record_size(items[i].1.len() as u64);
                if w.active.is_none() || (w.len + need > max && w.len > PACK_HEADER) {
                    self.open_new_pack(&mut w)?;
                }
                let Some((pid, file)) = w.active.clone() else {
                    return Err(StoreError::Db("no active pack".into()));
                };
                let start = w.len;
                let mut end = start;
                let mut buf = Vec::new();
                while i < items.len() {
                    let size = record_size(items[i].1.len() as u64);
                    if !buf.is_empty() && end + size > max {
                        break;
                    }
                    locs.push(PackLoc {
                        pack: pid,
                        offset: end,
                    });
                    encode_record(&items[i].0, items[i].1, &mut buf);
                    end += size;
                    i += 1;
                }
                // pin before the bytes exist so a concurrent compaction can never retire the pack
                // between this append and the caller's commit
                *lock(&self.packs.inflight).entry(pid).or_insert(0) += 1;
                pin.packs.push(pid);
                // on error the position is not advanced: the next append overwrites the partial bytes
                write_all_at(&file, &buf, start)?;
                w.len = end;
                if !touched.iter().any(|f| Arc::ptr_eq(f, &file)) {
                    touched.push(file);
                }
            }
        }
        self.packs.appends.fetch_add(1, Ordering::Relaxed);
        self.fail("pack.after_append")?;
        for f in &touched {
            let t = std::time::Instant::now();
            f.sync_all()?;
            crate::metrics::fsync("pack", t.elapsed());
            self.packs.fsyncs.fetch_add(1, Ordering::Relaxed);
        }
        Ok((locs, pin))
    }

    /// Makes `blob` durable as object `id` outside the group commit (fusion, unfuse, repair):
    /// appended to the active pack when small, else written as its own file. The pin must be held
    /// until the index transaction that records the location has finished.
    pub(crate) fn place_blob(
        &self,
        id: &Id,
        blob: &[u8],
    ) -> Result<(Option<PackLoc>, PackPin<'_>)> {
        if self.pack_eligible(blob.len()) {
            let (locs, pin) = self.pack_append(&[(*id, blob)])?;
            return Ok((locs.first().copied(), pin));
        }
        self.write_file_atomic(&self.object_path(id), blob)?;
        Ok((None, PackPin::none(self)))
    }

    fn pack_handle(&self, pack: u64) -> std::io::Result<Arc<File>> {
        {
            let mut h = lock(&self.packs.handles);
            h.tick += 1;
            let t = h.tick;
            if let Some(e) = h.map.get_mut(&pack) {
                e.1 = t;
                return Ok(e.0.clone());
            }
        }
        let f = Arc::new(File::open(self.pack_path(pack))?);
        let mut h = lock(&self.packs.handles);
        h.tick += 1;
        let t = h.tick;
        let out = h.map.entry(pack).or_insert((f, t)).0.clone();
        while h.map.len() > HANDLE_CACHE {
            let Some(oldest) = h.map.iter().min_by_key(|e| e.1 .1).map(|e| *e.0) else {
                break;
            };
            h.map.remove(&oldest);
        }
        Ok(out)
    }

    /// Reads and checks (magic, object id, length, CRC) the record at `loc`; returns its payload.
    pub(crate) fn read_packed(
        &self,
        id: &Id,
        loc: PackLoc,
        stored_len: u64,
    ) -> std::result::Result<Vec<u8>, String> {
        let f = self
            .pack_handle(loc.pack)
            .map_err(|e| format!("pack {} unreadable: {}", loc.pack, e))?;
        let mut buf = vec![0u8; record_size(stored_len) as usize];
        read_exact_at(&f, &mut buf, loc.offset).map_err(|e| {
            format!(
                "pack {} record at {} unreadable: {}",
                loc.pack, loc.offset, e
            )
        })?;
        check_record(id, &buf)?;
        buf.drain(..RECORD_HEADER as usize);
        Ok(buf)
    }

    /// Raw record payload without checks (best-effort copy into `quarantine/`).
    pub(crate) fn read_packed_unchecked(&self, loc: PackLoc, stored_len: u64) -> Option<Vec<u8>> {
        let f = self.pack_handle(loc.pack).ok()?;
        let mut buf = vec![0u8; stored_len as usize];
        read_exact_at(&f, &mut buf, loc.offset + RECORD_HEADER).ok()?;
        Some(buf)
    }

    /// Startup: truncates every pack to its committed end, removes pack files without an index row
    /// and reopens the newest pack for appending.
    pub(crate) fn recover_packs(&self) -> Result<()> {
        let dir = self.cfg.dir.join("packs");
        let rows: HashMap<u64, PackRec> = {
            let tx = self.db.begin_read()?;
            let t = tx.open_table(index::PACKS)?;
            let mut m = HashMap::new();
            for r in t.range::<u64>(..)? {
                let (k, v) = r?;
                m.insert(k.value(), PackRec::decode(v.value())?);
            }
            m
        };
        let mut max_id = rows.keys().copied().max().unwrap_or(0);
        let (mut truncated, mut removed) = (0u64, 0u64);
        let mut present: HashSet<u64> = HashSet::new();
        for e in std::fs::read_dir(&dir)? {
            let p = e?.path();
            let name = p
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let Some(id) = name
                .strip_suffix(".pack")
                .and_then(|h| u64::from_str_radix(h, 16).ok())
            else {
                continue;
            };
            max_id = max_id.max(id);
            let Some(row) = rows.get(&id) else {
                if std::fs::remove_file(&p).is_ok() {
                    removed += 1;
                }
                continue;
            };
            let len = std::fs::metadata(&p)?.len();
            if len > row.end {
                let f = OpenOptions::new().write(true).open(&p)?;
                f.set_len(row.end)?;
                f.sync_all()?;
                truncated += len - row.end;
                tracing::warn!(
                    "pack {}: truncated {} uncommitted / torn tail bytes",
                    id,
                    len - row.end
                );
            } else if len < row.end {
                tracing::warn!("pack {}: {} bytes on disk but {} committed; records beyond are lost (scrub quarantines them)", id, len, row.end);
                continue;
            }
            present.insert(id);
        }
        for id in rows.keys() {
            if !self.pack_path(*id).exists() {
                tracing::warn!(
                    "pack {} is missing (its objects will be quarantined by reads / scrub)",
                    id
                );
            }
        }
        self.packs
            .startup_truncated_bytes
            .store(truncated, Ordering::Relaxed);
        self.packs
            .startup_removed_packs
            .store(removed, Ordering::Relaxed);
        if removed > 0 {
            tracing::warn!("startup removed {} pack files without index rows", removed);
        }
        let mut w = lock(&self.packs.writer);
        w.next_id = max_id + 1;
        // continue appending to the newest intact pack that still has room
        if let Some((&id, row)) = rows
            .iter()
            .filter(|(id, _)| present.contains(id))
            .max_by_key(|(id, _)| **id)
        {
            if id == max_id && row.end < self.cfg.pack_max_bytes {
                let f = OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(self.pack_path(id))?;
                w.active = Some((id, Arc::new(f)));
                w.len = row.end;
            }
        }
        Ok(())
    }

    /// Id of the pack currently receiving appends.
    pub fn active_pack(&self) -> Option<u64> {
        lock(&self.packs.writer).active.as_ref().map(|a| a.0)
    }

    /// Where object `id`'s stored bytes live (test / debugging helper).
    #[doc(hidden)]
    pub fn object_storage(&self, id: &Id) -> Result<Option<ObjectStorage>> {
        let Some(rec) = self.object_rec(id)? else {
            return Ok(None);
        };
        Ok(Some(match rec.pack {
            Some(l) => ObjectStorage {
                path: self.pack_path(l.pack),
                offset: l.offset + RECORD_HEADER,
                len: rec.stored_len,
                pack: Some(l.pack),
            },
            None => ObjectStorage {
                path: self.object_path(id),
                offset: 0,
                len: rec.stored_len,
                pack: None,
            },
        }))
    }

    pub(crate) fn pack_rows(&self) -> Result<Vec<(u64, PackRec)>> {
        let tx = self.db.begin_read()?;
        let t = tx.open_table(index::PACKS)?;
        let mut out = Vec::new();
        for r in t.range::<u64>(..)? {
            let (k, v) = r?;
            out.push((k.value(), PackRec::decode(v.value())?));
        }
        Ok(out)
    }

    pub(crate) fn retired_packs(&self) -> Vec<u64> {
        lock(&self.packs.retired).iter().map(|r| r.0).collect()
    }

    /// Deletes retired pack files whose grace period elapsed (all of them with `force`).
    pub(crate) fn delete_retired_packs(&self, force: bool) -> u64 {
        if self.is_crashed() {
            return 0;
        }
        // a running backup may still be copying a retired pack's committed bytes
        let Ok(_gate) = self.maint_gate.try_read() else {
            return 0;
        };
        let ts = now();
        let due: Vec<u64> = {
            let mut r = lock(&self.packs.retired);
            let (due, keep): (Vec<_>, Vec<_>) = r.drain(..).partition(|(_, at)| force || *at <= ts);
            *r = keep;
            due.into_iter().map(|d| d.0).collect()
        };
        let mut n = 0;
        for pid in due {
            // never delete a pack the index points at (defensive: rows are removed before retiring)
            let has_row = self.db.begin_read().ok().and_then(|tx| {
                tx.open_table(index::PACKS)
                    .ok()?
                    .get(pid)
                    .ok()
                    .map(|g| g.is_some())
            });
            if has_row != Some(false) {
                continue;
            }
            lock(&self.packs.handles).map.remove(&pid);
            match std::fs::remove_file(self.pack_path(pid)) {
                Ok(()) => n += 1,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => lock(&self.packs.retired).push((pid, ts)),
            }
        }
        n
    }

    /// Seals the active pack: the next append starts a new one (rekey uses it so that the pack
    /// holding superseded copies becomes compactable).
    pub fn seal_active_pack(&self) {
        let mut w = lock(&self.packs.writer);
        w.active = None;
    }

    /// Compacts sealed packs whose live ratio fell below `pack_compact_ratio` (and drops sealed
    /// packs without live records). Retired files are deleted after `retire_grace_ms`.
    pub fn compact_packs(&self, retire_grace_ms: u64) -> Result<CompactReport> {
        self.compact_packs_with(self.cfg.pack_compact_ratio, retire_grace_ms)
    }

    /// [`Store::compact_packs`] with an explicit live ratio; `1.0` compacts every sealed pack that
    /// has any dead bytes.
    pub fn compact_packs_with(&self, ratio: f64, retire_grace_ms: u64) -> Result<CompactReport> {
        let _g = lock(&self.packs.compact_lock);
        let mut report = CompactReport::default();
        let active = self.active_pack();
        let targets: Vec<u64> = {
            let inflight = lock(&self.packs.inflight);
            self.pack_rows()?
                .into_iter()
                .filter(|(pid, r)| {
                    let data = r.end.saturating_sub(PACK_HEADER);
                    Some(*pid) != active
                        && !inflight.contains_key(pid)
                        && (r.live_objects == 0 || (r.live_bytes as f64) < ratio * data as f64)
                })
                .map(|(pid, _)| pid)
                .collect()
        };
        if !targets.is_empty() {
            // live records of the target packs (one index scan per pass)
            let set: HashSet<u64> = targets.iter().copied().collect();
            let mut live: HashMap<u64, Vec<(Id, PackLoc, u64)>> = HashMap::new();
            {
                let tx = self.db.begin_read()?;
                for r in tx.open_table(index::OBJECTS)?.range::<&[u8; 32]>(..)? {
                    let (k, v) = r?;
                    let rec = index::ObjectRec::decode(v.value())?;
                    if let Some(l) = rec.pack.filter(|l| set.contains(&l.pack)) {
                        live.entry(l.pack)
                            .or_default()
                            .push((*k.value(), l, rec.stored_len));
                    }
                }
            }
            for pid in targets {
                let mut objs = live.remove(&pid).unwrap_or_default();
                objs.sort_by_key(|o| o.1.offset);
                let mut i = 0;
                while i < objs.len() {
                    let mut bytes = 0u64;
                    let mut batch: Vec<(Id, PackLoc, u64, Vec<u8>)> = Vec::new();
                    while i < objs.len() && (batch.is_empty() || bytes < COMPACT_BATCH) {
                        let (id, loc, len) = objs[i];
                        i += 1;
                        match self.read_packed(&id, loc, len) {
                            Ok(b) => {
                                bytes += len;
                                batch.push((id, loc, len, b));
                            }
                            Err(reason) => {
                                // only a record that is still current is corrupt (else it moved)
                                if self.object_rec(&id)?.is_some_and(|r| r.pack == Some(loc)) {
                                    self.quarantine(&id, &reason);
                                }
                            }
                        }
                    }
                    if batch.is_empty() {
                        continue;
                    }
                    let items: Vec<(Id, &[u8])> =
                        batch.iter().map(|b| (b.0, b.3.as_slice())).collect();
                    let (locs, _pin) = self.pack_append(&items)?;
                    self.fail("compact.after_copy")?;
                    let moved = with_write(self, |t| {
                        let mut n = 0u64;
                        for ((id, old, len, _), new) in batch.iter().zip(&locs) {
                            let Some(mut rec) = t.get_obj(id)? else {
                                continue;
                            };
                            if rec.pack != Some(*old) || rec.stored_len != *len {
                                continue; // collected, quarantined or repaired meanwhile: the copy is garbage
                            }
                            t.pack_unlink(*old, *len)?;
                            t.pack_link(*new, *len)?;
                            rec.pack = Some(*new);
                            t.put_obj(id, &rec)?;
                            n += 1;
                        }
                        t.meta_add(meta::PACK_MOVED_OBJECTS, n as i64)?;
                        Ok(n)
                    })?;
                    report.objects_moved += moved;
                    report.bytes_moved += bytes;
                }
                // retire the pack once nothing in the index points into it any more
                let retired = with_write(self, |t| match t.get_pack(pid)? {
                    Some(r) if r.live_objects == 0 => {
                        t.packs.remove(pid)?;
                        t.meta_add(meta::PACK_COMPACTIONS, 1)?;
                        t.meta_add(meta::PACK_RECLAIMED, r.end as i64)?;
                        Ok(Some(r.end))
                    }
                    _ => Ok(None),
                })?;
                self.fail("compact.after_commit")?;
                if let Some(end) = retired {
                    report.packs_compacted += 1;
                    report.bytes_reclaimed += end;
                    lock(&self.packs.retired).push((pid, now().saturating_add(retire_grace_ms)));
                    tracing::info!("compacted pack {} ({} bytes retired)", pid, end);
                }
            }
        }
        report.retired_files_deleted = self.delete_retired_packs(false);
        Ok(report)
    }

    /// `packs` sub-object of `/store/stats`.
    pub(crate) fn packs_stats(&self, m: &HashMap<String, u64>) -> Result<serde_json::Value> {
        let rows = self.pack_rows()?;
        let active = self.active_pack();
        let (mut bytes, mut live, mut objects, mut dead) = (0u64, 0u64, 0u64, 0u64);
        for (_, r) in &rows {
            bytes += r.end;
            live += r.live_bytes;
            objects += r.live_objects;
            dead += r
                .end
                .saturating_sub(PACK_HEADER)
                .saturating_sub(r.live_bytes);
        }
        let g = |k: &str| m.get(k).copied().unwrap_or(0);
        let ld = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let p = &self.packs;
        Ok(serde_json::json!({
            "enabled": self.cfg.pack_threshold > 0,
            "threshold_bytes": self.cfg.pack_threshold,
            "max_pack_bytes": self.cfg.pack_max_bytes,
            "compact_live_ratio": self.cfg.pack_compact_ratio,
            "packs": rows.len(),
            "sealed_packs": rows.iter().filter(|(id, _)| Some(*id) != active).count(),
            "active_pack": active,
            "packed_objects": objects,
            "bytes": bytes,
            "live_bytes": live,
            "dead_bytes": dead,
            "compactions": g(meta::PACK_COMPACTIONS),
            "compaction_moved_objects": g(meta::PACK_MOVED_OBJECTS),
            "compaction_reclaimed_bytes": g(meta::PACK_RECLAIMED),
            "retired_pending_delete": lock(&p.retired).len(),
            "open_handles": lock(&p.handles).map.len(),
            "appends": ld(&p.appends),
            "fsyncs": ld(&p.fsyncs),
            "rotations": ld(&p.rotations),
            "startup_truncated_bytes": ld(&p.startup_truncated_bytes),
            "startup_removed_packs": ld(&p.startup_removed_packs),
        }))
    }

    /// fsck part for packs: rows vs. recomputed live bytes, records readable at their location,
    /// no stray pack files. `live` = recomputed `(bytes, objects)` per pack from the objects table.
    pub(crate) fn verify_packs(
        &self,
        live: &HashMap<u64, (u64, u64)>,
        problems: &mut dyn FnMut(String),
    ) -> Result<()> {
        let rows = self.pack_rows()?;
        let retired: HashSet<u64> = self.retired_packs().into_iter().collect();
        let row_ids: HashSet<u64> = rows.iter().map(|r| r.0).collect();
        for (pid, r) in &rows {
            let (lb, lo) = live.get(pid).copied().unwrap_or((0, 0));
            if (r.live_bytes, r.live_objects) != (lb, lo) {
                problems(format!(
                    "pack {}: row says {} live bytes / {} objects, recomputed {} / {}",
                    pid, r.live_bytes, r.live_objects, lb, lo
                ));
            }
            match std::fs::metadata(self.pack_path(*pid)) {
                Ok(md) if md.len() >= r.end => {}
                Ok(md) => problems(format!(
                    "pack {}: file has {} bytes, committed end {}",
                    pid,
                    md.len(),
                    r.end
                )),
                Err(_) => problems(format!("pack {}: file missing", pid)),
            }
        }
        for pid in live.keys() {
            if !row_ids.contains(pid) {
                problems(format!("objects point into pack {} which has no row", pid));
            }
        }
        if let Ok(rd) = std::fs::read_dir(self.cfg.dir.join("packs")) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                match name
                    .strip_suffix(".pack")
                    .and_then(|h| u64::from_str_radix(h, 16).ok())
                {
                    Some(id)
                        if row_ids.contains(&id)
                            || retired.contains(&id)
                            || Some(id) == self.active_pack() => {}
                    _ => problems(format!("orphan pack file {}", name)),
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_roundtrip_and_checks() {
        let id = [7u8; 32];
        let mut buf = Vec::new();
        encode_record(&id, b"hello pack", &mut buf);
        assert_eq!(buf.len() as u64, record_size(10));
        assert!(check_record(&id, &buf).is_ok());
        assert!(check_record(&[8u8; 32], &buf)
            .unwrap_err()
            .contains("different object"));
        let mut bad = buf.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert!(check_record(&id, &bad).unwrap_err().contains("CRC"));
        assert!(check_record(&id, &buf[..buf.len() - 1]).is_err());
        let mut bad = buf.clone();
        bad[0] ^= 1;
        assert!(check_record(&id, &bad).unwrap_err().contains("magic"));
    }
}
