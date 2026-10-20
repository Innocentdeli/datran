//! Streaming ingestion (NETWORK_SPEC §2 "Writes") and replica import for data gravity.
//!
//! Write path: body stream → FastCDC 2020 (16/64/256 KiB) → per chunk SHA-256 (+ incremental
//! whole-file SHA-256) → known chunk: reference only; new chunk: compress with the class champion,
//! verify decode → small objects (< pack threshold) are held in memory and appended to the active
//! pack by the group-commit leader (one write + one fsync for the whole batch); larger objects are
//! written to temp files → batched parallel fsync → rename → one index transaction that inserts
//! the manifest and all reference counts. Memory is bounded by the CDC buffer (256 KiB), one
//! unsynced batch of open temp files, at most 16 MiB of not-yet-packed small objects (beyond that
//! they are appended + fsynced early, still unindexed) and ~80 bytes of bookkeeping per chunk.
//! With `compress_threads` > 1, chunks are compressed on the shared pool and staged in order by a
//! stager thread (see [`Store::put_reader`]); add up to `ingest_inflight_bytes` (×2 with results).

use super::index::{self, meta, ChunkLoc, FileRec, ObjectRec, PackLoc};
use super::pack::PackPin;
use super::{
    class_code, id_hex, now, sha256, ChunkEntry, Id, Manifest, ObjEncoder, Reservation, Result,
    Store, StoreError, CDC_AVG, CDC_MAX, CDC_MIN, CHUNK_MAX, OBJECT_MAX_PLAIN,
};
use crate::classify;
use fastcdc::v2020::StreamCDC;
use redb::{ReadableDatabase, ReadableTable};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Read, Write};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Condvar, Mutex};

/// fsync/rename new object files in batches of this many objects (or bytes).
const SYNC_BATCH_OBJECTS: usize = 64;
const SYNC_BATCH_BYTES: u64 = 16 << 20;
const SYNC_THREADS: usize = 4;

#[derive(Clone, Debug)]
pub struct PutOptions {
    /// `x-content-type` hint.
    pub content_type: Option<String>,
    /// Feed a prefix to the evolution reservoir (false for `x-reactor-no-sample: 1`).
    pub sample: bool,
}

impl Default for PutOptions {
    fn default() -> Self {
        PutOptions {
            content_type: None,
            sample: true,
        }
    }
}

/// `{ file_id, size, stored_bytes, new_chunks, dedup_chunks, … }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PutOutcome {
    #[serde(with = "super::hex_id")]
    pub file_id: Id,
    pub size: u64,
    /// Physical bytes of objects newly written by this upload.
    pub stored_bytes: u64,
    /// Plaintext bytes of those new objects (compression of this upload = new_bytes / stored_bytes).
    pub new_bytes: u64,
    pub new_chunks: u64,
    pub dedup_chunks: u64,
    pub chunks: u64,
    pub class: &'static str,
    /// The file was already stored (only its pin count changed).
    pub duplicate: bool,
    pub pins: u64,
}

pub(crate) struct PendingObject {
    pub stored_len: u64,
    pub plain_len: u64,
    pub class: u8,
    pub members: Vec<(Id, u32)>,
    /// Goes into a pack (vs. its own file).
    pub in_pack: bool,
    /// Pack location once appended (early flush or by the group-commit leader).
    pub pack: Option<PackLoc>,
    /// Index flags of the new row (key slot of the active key the object was sealed under).
    pub flags: u8,
}

struct Unsynced {
    id: Id,
    tmp: PathBuf,
    file: Option<File>,
    len: u64,
}

/// New objects written by one upload/import that are not yet indexed.
pub(crate) struct Staging<'a> {
    store: &'a Store,
    res: Reservation<'a>,
    decided: HashSet<Id>,
    pending_objects: HashMap<Id, PendingObject>,
    /// chunk → (object, offset, len) for chunks that will be indexed at commit.
    pending_chunks: HashMap<Id, (Id, u32, u32)>,
    unsynced: Vec<Unsynced>,
    unsynced_bytes: u64,
    /// Small objects not yet appended to a pack (the group-commit leader appends them).
    packed: Vec<(Id, Vec<u8>)>,
    packed_bytes: u64,
    /// Packs holding this writer's early-flushed (not yet indexed) records.
    pins: PackPin<'a>,
    inflight: u64,
    pub stored_bytes: u64,
    pub new_bytes: u64,
    pub new_chunks: u64,
    pub dedup_chunks: u64,
    /// Handed to the group commit (no longer counted as a writer that may still submit).
    submitted: bool,
}

/// What a chunk needs (decided in chunk order by [`begin_chunk`]).
enum Begin {
    /// Already referenced by this upload, or already indexed: reference only.
    Known,
    /// An unreferenced object with exactly this plaintext exists (e.g. awaiting GC): reuse it.
    Reuse,
    /// Needs a new object: encode, then [`Staging::finish_chunk`].
    New,
}

/// Ordered first half of staging a chunk (called in chunk order): in-file dedup, reservation
/// (before the lookup, so GC cannot delete what we are about to reference) and the index lookup.
fn begin_chunk(
    store: &Store,
    res: &mut Reservation<'_>,
    decided: &mut HashSet<Id>,
    id: Id,
    len: u32,
) -> Result<Begin> {
    if !decided.insert(id) {
        return Ok(Begin::Known);
    }
    res.add(id);
    let tx = store.db.begin_read()?;
    if tx.open_table(index::CHUNK_LOC)?.get(&id)?.is_some() {
        return Ok(Begin::Known);
    }
    let existing = tx
        .open_table(index::OBJECTS)?
        .get(&id)?
        .map(|g| ObjectRec::decode(g.value()))
        .transpose()?;
    if existing.is_some_and(|o| !o.quarantined() && o.plain_len == len as u64) {
        return Ok(Begin::Reuse);
    }
    Ok(Begin::New)
}

/// The chunker thread's half of a parallel upload (merged into [`Staging`] before commit).
struct Front<'a> {
    res: Reservation<'a>,
    decided: HashSet<Id>,
    reuse: Vec<(Id, u32)>,
    dedup_chunks: u64,
}

impl Drop for Staging<'_> {
    fn drop(&mut self) {
        self.store
            .inflight_bytes
            .fetch_sub(self.inflight, Ordering::Relaxed);
        if !self.submitted {
            self.store.group.writer_done();
        }
        if self.store.is_crashed() {
            return;
        }
        for u in self.unsynced.drain(..) {
            drop(u.file);
            let _ = std::fs::remove_file(&u.tmp);
        }
    }
}

impl<'a> Staging<'a> {
    pub fn new(store: &'a Store) -> Staging<'a> {
        store.group.writer_started();
        Staging {
            store,
            res: Reservation::new(store),
            decided: HashSet::new(),
            pending_objects: HashMap::new(),
            pending_chunks: HashMap::new(),
            unsynced: Vec::new(),
            unsynced_bytes: 0,
            packed: Vec::new(),
            packed_bytes: 0,
            pins: PackPin::none(store),
            inflight: 0,
            stored_bytes: 0,
            new_bytes: 0,
            new_chunks: 0,
            dedup_chunks: 0,
            submitted: false,
        }
    }

    /// Makes sure chunk `id` (plaintext `data`) will be indexed at commit: either it already is
    /// (reference only) or a new object is staged. Sequential form of
    /// [`begin_chunk`] → encode → [`Staging::finish_chunk`].
    pub fn stage_chunk(&mut self, id: Id, data: &[u8], enc: &ObjEncoder) -> Result<()> {
        let len = data.len() as u32;
        match begin_chunk(self.store, &mut self.res, &mut self.decided, id, len)? {
            Begin::Known => {
                self.dedup_chunks += 1;
                Ok(())
            }
            Begin::Reuse => {
                self.pending_chunks.insert(id, (id, 0, len));
                self.dedup_chunks += 1;
                Ok(())
            }
            Begin::New => {
                let blob = self.store.encode_sealed(enc, &id, data)?;
                self.finish_chunk(id, len, class_code(enc.class), blob)
            }
        }
    }

    /// Takes over the chunker's half of a parallel upload (reservations, in-file dedup decisions,
    /// reused objects and dedup count) so commit / release see one writer.
    fn absorb_front(&mut self, f: Front<'a>) {
        self.res.absorb(f.res);
        self.decided.extend(f.decided);
        for (id, len) in f.reuse {
            self.pending_chunks.insert(id, (id, 0, len));
        }
        self.dedup_chunks += f.dedup_chunks;
    }

    /// Ordered second half (called in chunk order for the chunks `begin_chunk` accepted):
    /// capacity admission and staging of the encoded object.
    fn finish_chunk(&mut self, id: Id, len: u32, class: u8, blob: Vec<u8>) -> Result<()> {
        self.admit(blob.len() as u64)?;
        self.stage_blob(id, blob, len as u64, class, vec![(id, len)])?;
        self.pending_chunks.insert(id, (id, 0, len));
        self.new_chunks += 1;
        Ok(())
    }

    fn admit(&mut self, bytes: u64) -> Result<()> {
        self.store.admit(bytes)?;
        self.inflight += bytes;
        Ok(())
    }

    /// Stages a small `blob` for the pack (appended at commit by the group-commit leader, or early
    /// once 16 MiB accumulated), a large one in a temp file (fsync + rename happen in batches in
    /// `flush`).
    fn stage_blob(
        &mut self,
        id: Id,
        blob: Vec<u8>,
        plain_len: u64,
        class: u8,
        members: Vec<(Id, u32)>,
    ) -> Result<()> {
        self.new_bytes += plain_len;
        if self.store.pack_eligible(blob.len()) {
            let n = blob.len() as u64;
            let flags = self.store.new_object_flags();
            self.pending_objects.insert(
                id,
                PendingObject {
                    stored_len: n,
                    plain_len,
                    class,
                    members,
                    in_pack: true,
                    pack: None,
                    flags,
                },
            );
            self.packed.push((id, blob));
            self.packed_bytes += n;
            self.stored_bytes += n;
            if self.packed_bytes >= SYNC_BATCH_BYTES {
                self.flush_packed()?;
            }
            return Ok(());
        }
        let blob = blob.as_slice();
        let path = self.store.object_path(&id);
        let dir = path.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        std::fs::create_dir_all(&dir)?;
        let n = self.store.tmp_counter.fetch_add(1, Ordering::Relaxed);
        let tmp = dir.join(format!(
            ".{}.obj.{}.{}.tmp",
            id_hex(&id),
            std::process::id(),
            n
        ));
        let mut f = File::create(&tmp)?;
        // register before writing so a failure removes the temp file
        self.unsynced.push(Unsynced {
            id,
            tmp,
            file: None,
            len: blob.len() as u64,
        });
        f.write_all(blob)?;
        if let Some(u) = self.unsynced.last_mut() {
            u.file = Some(f);
        }
        self.unsynced_bytes += blob.len() as u64;
        self.stored_bytes += blob.len() as u64;
        let flags = self.store.new_object_flags();
        self.pending_objects.insert(
            id,
            PendingObject {
                stored_len: blob.len() as u64,
                plain_len,
                class,
                members,
                in_pack: false,
                pack: None,
                flags,
            },
        );
        if self.unsynced.len() >= SYNC_BATCH_OBJECTS || self.unsynced_bytes >= SYNC_BATCH_BYTES {
            self.flush()?;
        }
        Ok(())
    }

    /// Appends the held small objects to the active pack now (fsynced, not yet indexed) to bound
    /// memory; their records are garbage if this upload never commits.
    fn flush_packed(&mut self) -> Result<()> {
        if self.packed.is_empty() {
            return Ok(());
        }
        let store: &'a Store = self.store;
        let items: Vec<(Id, &[u8])> = self
            .packed
            .iter()
            .map(|(id, b)| (*id, b.as_slice()))
            .collect();
        let (locs, pin) = store.pack_append(&items)?;
        drop(items);
        self.pins.absorb(pin);
        for ((id, _), loc) in self.packed.iter().zip(locs) {
            if let Some(p) = self.pending_objects.get_mut(id) {
                p.pack = Some(loc);
            }
        }
        self.packed.clear();
        self.packed_bytes = 0;
        Ok(())
    }

    /// fsyncs the unsynced batch in parallel, then renames every temp file into place.
    pub fn flush(&mut self) -> Result<()> {
        if self.unsynced.is_empty() {
            return Ok(());
        }
        let per = self.unsynced.len().div_ceil(SYNC_THREADS);
        let sync_err: Option<std::io::Error> = if self.unsynced.len() == 1 {
            self.unsynced[0]
                .file
                .as_ref()
                .and_then(|f| f.sync_all().err())
        } else {
            std::thread::scope(|s| {
                let handles: Vec<_> = self
                    .unsynced
                    .chunks(per)
                    .map(|group| {
                        s.spawn(move || -> std::io::Result<()> {
                            for u in group {
                                if let Some(f) = &u.file {
                                    f.sync_all()?;
                                }
                            }
                            Ok(())
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .filter_map(|h| h.join().ok().and_then(|r| r.err()))
                    .next()
            })
        };
        if let Some(e) = sync_err {
            return Err(StoreError::Io(e));
        }
        self.store.fail("write.before_rename")?;
        while let Some(mut u) = self.unsynced.pop() {
            drop(u.file.take());
            self.res.created(u.id);
            match self.store.install_temp(&u.id, &u.tmp) {
                Ok(len) => {
                    if let Some(p) = self.pending_objects.get_mut(&u.id) {
                        if len != u.len {
                            self.stored_bytes = self.stored_bytes + len - u.len;
                        }
                        p.stored_len = len;
                    }
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&u.tmp);
                    return Err(e);
                }
            }
        }
        self.unsynced_bytes = 0;
        Ok(())
    }

    /// Plaintext of a chunk that is either staged here or indexed (used to verify imports).
    fn chunk_plain(&self, id: &Id, cache: &mut Option<(Id, Vec<u8>)>) -> Result<Vec<u8>> {
        let (obj, off, len) = match self.pending_chunks.get(id) {
            Some(p) => *p,
            None => {
                let tx = self.store.db.begin_read()?;
                let loc = tx
                    .open_table(index::CHUNK_LOC)?
                    .get(id)?
                    .map(|g| ChunkLoc::decode(g.value()))
                    .transpose()?
                    .ok_or_else(|| {
                        StoreError::Invalid(format!("chunk {} not available", id_hex(id)))
                    })?;
                (loc.object, loc.offset, loc.len)
            }
        };
        if cache.as_ref().map(|c| c.0) != Some(obj) {
            // staged objects are not indexed yet: held in memory, or early-flushed into a pack
            let plain = if let Some((_, blob)) = self.packed.iter().find(|(i, _)| *i == obj) {
                self.store
                    .decode_blob(&self.store.open_stored(&obj, blob)?)?
            } else if let Some((loc, len)) = self
                .pending_objects
                .get(&obj)
                .and_then(|p| p.pack.map(|l| (l, p.stored_len)))
            {
                let raw = self
                    .store
                    .read_packed(&obj, loc, len)
                    .map_err(StoreError::Corrupt)?;
                self.store
                    .decode_blob(&self.store.open_stored(&obj, &raw)?)?
            } else {
                self.store.read_object_plain(&obj)?
            };
            *cache = Some((obj, plain));
        }
        let plain = &cache
            .as_ref()
            .map(|c| &c.1)
            .ok_or_else(|| StoreError::Corrupt("cache".into()))?;
        let (s, e) = (off as usize, off as usize + len as usize);
        if e > plain.len() || sha256(&plain[s..e]) != *id {
            return Err(StoreError::Corrupt(format!(
                "chunk {} failed verification",
                id_hex(id)
            )));
        }
        Ok(plain[s..e].to_vec())
    }

    /// Makes the upload durable and visible: the last object files are fsynced and renamed into
    /// place, then the index transaction (manifest + reference counts, or +1 pin for a known
    /// file) goes through the store's group commit, which merges concurrent writers' index
    /// transactions into one commit (one redb fsync). Returns only after this upload's data and
    /// index entry are durable.
    #[allow(clippy::too_many_arguments)]
    pub fn commit(
        mut self,
        file_id: Id,
        size: u64,
        chunks: &[(u64, Id, u32)],
        class: &'static str,
        created_ms: u64,
        origin: bool,
        pin: bool,
    ) -> Result<(bool, u64)> {
        // Object files: fsync + rename in this writer's thread (in parallel with other writers).
        // Small objects travel with the job: the leader appends the whole batch to the pack.
        self.flush()?;
        self.store.fail("write.before_commit")?;
        self.packed_bytes = 0;
        let job = super::group::CommitJob {
            packed: std::mem::take(&mut self.packed),
            pending_objects: std::mem::take(&mut self.pending_objects),
            pending_chunks: std::mem::take(&mut self.pending_chunks),
            file_id,
            size,
            chunks: chunks.to_vec(),
            class: class_code(class),
            created_ms,
            origin,
            pin,
        };
        self.submitted = true;
        let out = self.store.group_commit(job)?;
        if out.0 {
            // Known file: nothing staged here is referenced; release deletes unindexed files.
            self.stored_bytes = 0;
            self.new_bytes = 0;
        }
        Ok(out)
    }
}

/// Applies one upload's index changes inside a (possibly shared) write transaction.
pub(crate) fn apply_commit(
    t: &mut super::index::Tables<'_>,
    job: &super::group::CommitJob,
    ts: u64,
) -> Result<(bool, u64)> {
    let file_id = job.file_id;
    if let Some(mut rec) = t.get_file(&file_id)? {
        let mut pins = t.pins.get(&file_id)?.map(|g| g.value()).unwrap_or(0);
        if job.pin {
            pins += 1;
            t.pins.insert(&file_id, pins)?;
        }
        if job.origin && !rec.origin {
            rec.origin = true;
            t.manifests.insert(&file_id, rec.encode().as_slice())?;
        }
        return Ok((true, pins));
    }
    let mut occ: HashMap<Id, (u64, u32)> = HashMap::with_capacity(job.chunks.len());
    for (_, id, len) in &job.chunks {
        occ.entry(*id).or_insert((0, *len)).0 += 1;
    }
    for (id, (k, len)) in occ {
        if let Some(loc) = t.get_loc(&id)? {
            if loc.len != len {
                return Err(StoreError::Corrupt(format!(
                    "chunk {} length mismatch",
                    id_hex(&id)
                )));
            }
            t.chunk_ref_add(&id, loc, k)?;
            continue;
        }
        let (obj, off, clen) = job.pending_chunks.get(&id).copied().ok_or_else(|| {
            StoreError::Corrupt(format!("chunk {} neither indexed nor staged", id_hex(&id)))
        })?;
        if clen != len {
            return Err(StoreError::Invalid(format!(
                "chunk {} length mismatch",
                id_hex(&id)
            )));
        }
        match t.get_obj(&obj)? {
            Some(mut o) => {
                if !o.members.contains(&id) {
                    o.members.push(id);
                    o.lens.push(len);
                    t.put_obj(&obj, &o)?;
                }
            }
            None => {
                let p = job.pending_objects.get(&obj).ok_or_else(|| {
                    StoreError::Corrupt(format!("object {} vanished before commit", id_hex(&obj)))
                })?;
                if p.in_pack && p.pack.is_none() {
                    return Err(StoreError::Corrupt(format!(
                        "object {} was not written to a pack",
                        id_hex(&obj)
                    )));
                }
                t.insert_object(
                    &obj,
                    &ObjectRec {
                        stored_len: p.stored_len,
                        plain_len: p.plain_len,
                        refcount: 0,
                        created_ms: ts,
                        class: p.class,
                        flags: p.flags,
                        members: p.members.iter().map(|m| m.0).collect(),
                        lens: p.members.iter().map(|m| m.1).collect(),
                        pack: p.pack,
                    },
                )?;
            }
        }
        let loc = ChunkLoc {
            object: obj,
            offset: off,
            len,
            refs: 0,
        };
        t.put_loc(&id, &loc)?;
        t.chunk_ref_add(&id, loc, k)?;
    }
    for (off, id, len) in &job.chunks {
        t.mchunks.insert(
            &index::mchunk_key(&file_id, *off),
            &index::mchunk_val(id, *len),
        )?;
    }
    let rec = FileRec {
        size: job.size,
        chunk_count: job.chunks.len() as u64,
        created_ms: job.created_ms,
        origin: job.origin,
        class: job.class,
    };
    t.manifests.insert(&file_id, rec.encode().as_slice())?;
    let pins = if job.pin { 1 } else { 0 };
    if job.pin {
        t.pins.insert(&file_id, 1u64)?;
    }
    t.meta_add(meta::FILES, 1)?;
    t.meta_add(meta::LOGICAL, job.size as i64)?;
    t.log_event(index::LOG_ADD, &file_id)?;
    Ok((false, pins))
}

type EncodeResult = Result<Vec<u8>>;

/// One chunk handed to the pool: (chunk id, plaintext length, class code, result).
type Submitted = (Id, u32, u8, mpsc::Receiver<EncodeResult>);

/// In-flight byte budget of one parallel upload (plaintext bytes handed to the pool and not yet
/// staged), shared by its chunker and stager threads. One chunk always fits.
struct Credit {
    /// (in-flight bytes, stager gave up)
    state: Mutex<(u64, bool)>,
    cv: Condvar,
    cap: u64,
}

impl Credit {
    fn new(cap: u64) -> Credit {
        Credit {
            state: Mutex::new((0, false)),
            cv: Condvar::new(),
            cap,
        }
    }

    /// Waits until `len` more bytes fit; returns the new in-flight total, `None` once aborted.
    fn acquire(&self, len: u64) -> Option<u64> {
        let mut g = super::lock(&self.state);
        while !g.1 && g.0 > 0 && g.0 + len > self.cap {
            g = self.cv.wait(g).unwrap_or_else(|p| p.into_inner());
        }
        if g.1 {
            return None;
        }
        g.0 += len;
        crate::metrics::ingest_inflight_add(len as i64);
        Some(g.0)
    }

    fn release(&self, len: u64) {
        let mut g = super::lock(&self.state);
        let n = len.min(g.0);
        g.0 -= n;
        crate::metrics::ingest_inflight_add(-(n as i64));
        self.cv.notify_all();
    }

    fn abort(&self) {
        super::lock(&self.state).1 = true;
        self.cv.notify_all();
    }
}

impl Drop for Credit {
    fn drop(&mut self) {
        // an aborted upload never releases its outstanding credit: take it off the global gauge
        let left = super::lock(&self.state).0;
        crate::metrics::ingest_inflight_add(-(left as i64));
    }
}

/// What the chunker produced for one upload.
struct Chunked {
    file_id: Id,
    size: u64,
    chunks: Vec<(u64, Id, u32)>,
    class: &'static str,
    sample: Vec<u8>,
}

fn stager_gone() -> StoreError {
    StoreError::Corrupt("ingest stager stopped".into())
}

fn cdc_err(e: fastcdc::v2020::Error) -> StoreError {
    match e {
        fastcdc::v2020::Error::IoError(e) => StoreError::Io(e),
        other => StoreError::Io(std::io::Error::other(other.to_string())),
    }
}

impl Store {
    /// Capacity admission for `bytes` of new physical data (evicts via the policy when needed).
    pub(crate) fn admit(&self, bytes: u64) -> Result<()> {
        let Some(max) = self.cfg.max_bytes else {
            self.inflight_bytes.fetch_add(bytes, Ordering::Relaxed);
            return Ok(());
        };
        let mut evicted = false;
        loop {
            let live = self.meta_value(meta::LIVE)?;
            let prev = self.inflight_bytes.fetch_add(bytes, Ordering::Relaxed);
            let used = live + prev;
            if used + bytes <= max {
                return Ok(());
            }
            self.inflight_bytes.fetch_sub(bytes, Ordering::Relaxed);
            if !evicted {
                evicted = true;
                if self.evict(used + bytes - max)? > 0 {
                    continue;
                }
            }
            self.stats.full_rejections.fetch_add(1, Ordering::Relaxed);
            return Err(StoreError::Full {
                needed: bytes,
                used,
                max,
            });
        }
    }

    /// Moves a synced temp file into place. If a verified object file already exists (concurrent
    /// writer), the temp file is discarded and the existing length returned.
    pub(crate) fn install_temp(&self, id: &Id, tmp: &std::path::Path) -> Result<u64> {
        let path = self.object_path(id);
        let _g = super::lock(&self.place_locks[id[0] as usize % self.place_locks.len()]);
        if let Ok(existing) = std::fs::read(&path) {
            if self.decode_stored(id, &existing).is_ok() {
                let _ = std::fs::remove_file(tmp);
                return Ok(existing.len() as u64);
            }
        }
        std::fs::rename(tmp, &path)?;
        #[cfg(unix)]
        if let Some(d) = path.parent().and_then(|d| File::open(d).ok()) {
            let _ = d.sync_all();
        }
        Ok(std::fs::metadata(&path)?.len())
    }

    /// Streams a file in from `reader` (never buffered whole). Duplicate content increments the pin.
    ///
    /// With `compress_threads` > 1 the upload runs as a three-stage pipeline: this thread chunks,
    /// hashes and decides each chunk in order ([`begin_chunk`]: in-file dedup, reservation, index
    /// lookup); new chunks are compressed on the shared pool ([`crate::workers`]); a stager thread
    /// stages the results strictly in chunk order ([`Staging::finish_chunk`]: admission, pack /
    /// temp-file writes, early flushes), so staged objects, pack layout, manifest and counters
    /// are exactly those of the sequential path. At most `ingest_inflight_bytes` of plaintext are
    /// between the chunker and the stager.
    pub fn put_reader<R: Read>(&self, reader: R, opts: &PutOptions) -> Result<PutOutcome> {
        let mut st = Staging::new(self);
        let c = if self.cfg.compress_threads > 1 {
            self.chunk_parallel(reader, opts, &mut st)?
        } else {
            self.chunk_stream(reader, opts, |id, data, enc| st.stage_chunk(id, &data, enc))?
        };
        let (new_chunks, dedup_chunks) = (st.new_chunks, st.dedup_chunks);
        let (mut stored_bytes, mut new_bytes) = (st.stored_bytes, st.new_bytes);
        let (duplicate, pins) = {
            let r = st.commit(c.file_id, c.size, &c.chunks, c.class, now(), true, true)?;
            if r.0 {
                stored_bytes = 0;
                new_bytes = 0;
            }
            r
        };
        if !c.sample.is_empty() {
            self.engine.observe(c.class, &c.sample);
        }
        self.stats.puts.fetch_add(1, Ordering::Relaxed);
        self.stats.put_bytes.fetch_add(c.size, Ordering::Relaxed);
        Ok(PutOutcome {
            file_id: c.file_id,
            size: c.size,
            stored_bytes,
            new_bytes,
            new_chunks: if duplicate { 0 } else { new_chunks },
            dedup_chunks: if duplicate {
                c.chunks.len() as u64
            } else {
                dedup_chunks
            },
            chunks: c.chunks.len() as u64,
            class: c.class,
            duplicate,
            pins,
        })
    }

    /// FastCDC + whole-file / per-chunk SHA-256 + evolution sample; `on_chunk` gets every chunk
    /// in order.
    fn chunk_stream<R: Read>(
        &self,
        reader: R,
        opts: &PutOptions,
        mut on_chunk: impl FnMut(Id, Vec<u8>, &Arc<ObjEncoder>) -> Result<()>,
    ) -> Result<Chunked> {
        let mut hasher = Sha256::new();
        let mut chunks: Vec<(u64, Id, u32)> = Vec::new();
        let mut size = 0u64;
        let mut enc: Option<Arc<ObjEncoder>> = None;
        let sample_max = if opts.sample {
            self.engine.cfg.sample_bytes_max
        } else {
            0
        };
        let mut sample: Vec<u8> = Vec::new();
        for item in StreamCDC::new(reader, CDC_MIN, CDC_AVG, CDC_MAX) {
            let c = item.map_err(cdc_err)?;
            let data = c.data;
            hasher.update(&data);
            let enc = enc.get_or_insert_with(|| {
                Arc::new(self.encoder(classify::classify(&data, opts.content_type.as_deref())))
            });
            if sample.len() < sample_max {
                let take = (sample_max - sample.len()).min(data.len());
                sample.extend_from_slice(&data[..take]);
            }
            let id = sha256(&data);
            let len = data.len() as u32;
            on_chunk(id, data, enc)?;
            chunks.push((size, id, len));
            size += len as u64;
        }
        let class = enc.as_ref().map(|e| e.class).unwrap_or(classify::EMPTY);
        Ok(Chunked {
            file_id: hasher.finalize().into(),
            size,
            chunks,
            class,
            sample,
        })
    }

    /// The parallel pipeline of [`Store::put_reader`].
    fn chunk_parallel<'a, R: Read>(
        &'a self,
        reader: R,
        opts: &PutOptions,
        st: &mut Staging<'a>,
    ) -> Result<Chunked> {
        let credit = Credit::new(self.cfg.ingest_inflight_bytes.max(1));
        let mut front = Front {
            res: Reservation::new(self),
            decided: HashSet::new(),
            reuse: Vec::new(),
            dedup_chunks: 0,
        };
        let (tx, rx) = mpsc::channel::<Submitted>();
        let (chunked, staged) = std::thread::scope(|s| {
            let (credit, stage) = (&credit, &mut *st);
            let stager = s.spawn(move || -> Result<()> {
                let r = rx.iter().try_for_each(|(id, len, class, res)| {
                    let blob = res
                        .recv()
                        .map_err(|_| StoreError::Corrupt("compression worker vanished".into()))??;
                    stage.finish_chunk(id, len, class, blob)?;
                    credit.release(len as u64);
                    Ok(())
                });
                if r.is_err() {
                    credit.abort();
                }
                r
            });
            let front = &mut front;
            let chunked = self.chunk_stream(reader, opts, move |id, data, enc| {
                let len = data.len() as u32;
                match begin_chunk(self, &mut front.res, &mut front.decided, id, len)? {
                    Begin::Known => front.dedup_chunks += 1,
                    Begin::Reuse => {
                        front.reuse.push((id, len));
                        front.dedup_chunks += 1;
                    }
                    Begin::New => {
                        let total = credit.acquire(len as u64).ok_or_else(stager_gone)?;
                        self.stats
                            .ingest_inflight_peak
                            .fetch_max(total, Ordering::Relaxed);
                        self.stats.pool_chunks.fetch_add(1, Ordering::Relaxed);
                        let (rtx, rrx) = mpsc::sync_channel::<EncodeResult>(1);
                        let class = class_code(enc.class);
                        let (engine, enc) = (self.engine.clone(), enc.clone());
                        let job: Box<dyn FnOnce() + Send> = Box::new(move || {
                            // compress, verify and seal on the pool (encryption scales with it)
                            let r = std::panic::catch_unwind(AssertUnwindSafe(|| {
                                super::encode_verified_with(&engine, &enc, &data).map(|b| {
                                    engine.cfg.keys.seal(crate::crypto::Kind::Object, &id, b)
                                })
                            }))
                            .unwrap_or_else(|_| {
                                Err(StoreError::Corrupt("compression worker panicked".into()))
                            });
                            let _ = rtx.send(r);
                        });
                        if let Err(job) = crate::workers::pool().spawn(job) {
                            job();
                        }
                        tx.send((id, len, class, rrx)).map_err(|_| stager_gone())?;
                    }
                }
                Ok(())
            });
            // `tx` was moved into the chunker closure and is dropped by now: the stager drains
            // what was submitted and exits
            let staged = stager
                .join()
                .unwrap_or_else(|_| Err(StoreError::Corrupt("ingest stager panicked".into())));
            (chunked, staged)
        });
        st.absorb_front(front);
        staged?;
        chunked
    }

    pub fn put_bytes(&self, data: &[u8], opts: &PutOptions) -> Result<PutOutcome> {
        self.put_reader(data, opts)
    }

    /// Starts importing a replica described by a peer manifest (data gravity). Chunks already
    /// stored locally are reserved immediately; the rest must be supplied with
    /// [`Import::add_object`] / [`Import::add_chunk`] before [`Import::commit`].
    pub fn begin_import(&self, manifest: Manifest) -> Result<Import<'_>> {
        let total: u64 = manifest.chunks.iter().map(|c| c.len as u64).sum();
        if total != manifest.size {
            return Err(StoreError::Invalid(format!(
                "manifest chunk lengths sum to {} but size is {}",
                total, manifest.size
            )));
        }
        if manifest
            .chunks
            .iter()
            .any(|c| c.len == 0 || c.len as usize > CHUNK_MAX)
        {
            return Err(StoreError::Invalid(
                "manifest chunk length out of range".into(),
            ));
        }
        let mut st = Staging::new(self);
        let ids: Vec<Id> = manifest
            .chunks
            .iter()
            .map(|c| c.id)
            .collect::<HashSet<_>>()
            .into_iter()
            .collect();
        st.res.add_all(&ids);
        let mut missing = HashSet::new();
        {
            let tx = self.db.begin_read()?;
            let locs = tx.open_table(index::CHUNK_LOC)?;
            for c in &manifest.chunks {
                if locs.get(&c.id)?.is_none() {
                    missing.insert(c.id);
                }
            }
        }
        Ok(Import {
            st,
            manifest,
            missing,
        })
    }
}

/// Replica import session (see [`Store::begin_import`]). Dropping it without commit discards
/// everything it staged.
pub struct Import<'a> {
    st: Staging<'a>,
    manifest: Manifest,
    missing: HashSet<Id>,
}

impl Import<'_> {
    pub fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    /// Chunk ids not yet available locally.
    pub fn missing_chunks(&self) -> Vec<Id> {
        let mut v: Vec<Id> = self.missing.iter().copied().collect();
        v.sort_unstable();
        v
    }

    pub fn is_complete(&self) -> bool {
        self.missing.is_empty()
    }

    /// Adds an object fetched from a peer (`GET /cluster/objects/:id`, transport form = blob v2).
    /// It is verified (decode, plaintext SHA-256 = `object_id`, every member's SHA-256 at its
    /// offset) and stored as-is, sealed under this node's active key. `members` are the object's chunks in plaintext order. Returns how many missing
    /// chunks it satisfied (an object that satisfies none is not stored).
    pub fn add_object(
        &mut self,
        object_id: &Id,
        raw: &[u8],
        members: &[ChunkEntry],
    ) -> Result<usize> {
        if raw.len() > OBJECT_MAX_PLAIN + 1024 {
            return Err(StoreError::Invalid("object too large".into()));
        }
        let store = self.st.store;
        let plain = store.decode_object(object_id, raw)?;
        let total: u64 = members.iter().map(|m| m.len as u64).sum();
        if total != plain.len() as u64 {
            return Err(StoreError::Invalid(
                "member lengths do not cover the object".into(),
            ));
        }
        let mut off = 0usize;
        let mut useful = Vec::new();
        for m in members {
            let end = off + m.len as usize;
            if sha256(&plain[off..end]) != m.id {
                return Err(StoreError::Invalid(format!(
                    "member {} hash mismatch",
                    id_hex(&m.id)
                )));
            }
            if self.missing.contains(&m.id) && !useful.iter().any(|(id, _, _)| *id == m.id) {
                useful.push((m.id, off as u32, m.len));
            }
            off = end;
        }
        if useful.is_empty() {
            return Ok(0);
        }
        self.st.res.add(*object_id);
        let existing = store.object_rec(object_id)?;
        match existing {
            Some(o) if !o.quarantined() => {}
            _ => {
                let stored = store.seal_object(object_id, raw.to_vec());
                self.st.admit(stored.len() as u64)?;
                let class = class_code(classify::classify(
                    &plain[..plain.len().min(64 * 1024)],
                    None,
                ));
                let ids = members.iter().map(|m| (m.id, m.len)).collect();
                self.st
                    .stage_blob(*object_id, stored, plain.len() as u64, class, ids)?;
                self.st.new_chunks += useful.len() as u64;
            }
        }
        for (id, o, len) in &useful {
            self.st.pending_chunks.insert(*id, (*object_id, *o, *len));
            self.st.decided.insert(*id);
            self.missing.remove(id);
        }
        Ok(useful.len())
    }

    /// Adds one chunk's plaintext (compressed locally with the champion recipe).
    pub fn add_chunk(&mut self, chunk_id: &Id, plain: &[u8]) -> Result<bool> {
        if sha256(plain) != *chunk_id {
            return Err(StoreError::Invalid(format!(
                "chunk {} hash mismatch",
                id_hex(chunk_id)
            )));
        }
        if !self.missing.contains(chunk_id) {
            return Ok(false);
        }
        let enc = self.st.store.encoder(classify::classify(plain, None));
        self.st.stage_chunk(*chunk_id, plain, &enc)?;
        self.missing.remove(chunk_id);
        Ok(true)
    }

    /// Verifies that the chunks hash to the manifest's file id, then commits the replica
    /// (origin = false, no pin) in one index transaction. Committing a file that is already
    /// stored is a no-op.
    pub fn commit(mut self) -> Result<PutOutcome> {
        if !self.missing.is_empty() {
            return Err(StoreError::Invalid(format!(
                "{} chunks still missing",
                self.missing.len()
            )));
        }
        self.st.flush()?;
        let mut hasher = Sha256::new();
        let mut cache = None;
        let mut class = classify::EMPTY;
        let mut chunks = Vec::with_capacity(self.manifest.chunks.len());
        let mut off = 0u64;
        for (i, c) in self.manifest.chunks.iter().enumerate() {
            let plain = self.st.chunk_plain(&c.id, &mut cache)?;
            if plain.len() != c.len as usize {
                return Err(StoreError::Invalid(format!(
                    "chunk {} length mismatch",
                    id_hex(&c.id)
                )));
            }
            if i == 0 {
                class = classify::classify(&plain, None);
            }
            hasher.update(&plain);
            chunks.push((off, c.id, c.len));
            off += c.len as u64;
        }
        let fid: Id = hasher.finalize().into();
        if fid != self.manifest.file_id {
            return Err(StoreError::Invalid(
                "chunks do not hash to the manifest file id".into(),
            ));
        }
        let (new_chunks, dedup_chunks, stored, new_bytes) = (
            self.st.new_chunks,
            self.st.dedup_chunks,
            self.st.stored_bytes,
            self.st.new_bytes,
        );
        let m = &self.manifest;
        let (duplicate, pins) = self.st.commit(
            m.file_id,
            m.size,
            &chunks,
            class,
            m.created_ms,
            false,
            false,
        )?;
        Ok(PutOutcome {
            file_id: m.file_id,
            size: m.size,
            stored_bytes: if duplicate { 0 } else { stored },
            new_bytes: if duplicate { 0 } else { new_bytes },
            new_chunks,
            dedup_chunks,
            chunks: chunks.len() as u64,
            class,
            duplicate,
            pins,
        })
    }
}
