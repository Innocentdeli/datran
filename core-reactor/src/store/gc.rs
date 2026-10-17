//! Unpin / tombstones / replica drop, capacity eviction hook and garbage collection
//! (NETWORK_SPEC §2 "Delete", "Capacity").

use super::index::{self, meta, ObjectRec, Tables};
use super::{lock, now, with_write, FileMeta, Id, Result, Store, StoreError};
use redb::{ReadableDatabase, ReadableTable};
use serde::Serialize;
use std::sync::atomic::Ordering;

/// Decides which files may be evicted when the store is over capacity. Data gravity (§4)
/// installs a policy that knows replica counts and demand; the default never evicts a pinned
/// origin file.
pub trait EvictionPolicy: Send + Sync {
    /// Whether this file may be dropped from this node. Default: not if it is a pinned origin file.
    fn can_evict(&self, meta: &FileMeta) -> bool {
        !(meta.origin && meta.pins > 0)
    }

    /// Files to evict (coldest first) to free about `need_bytes`. The store calls
    /// [`EvictionPolicy::can_evict`] again on each before dropping it. The default offers every
    /// evictable file in index order (scan bounded to 10 000 files).
    fn candidates(&self, store: &Store, need_bytes: u64) -> Vec<Id> {
        let _ = need_bytes;
        store
            .list_files(None, 10_000)
            .map(|v| v.into_iter().filter(|m| self.can_evict(m)).map(|m| m.file_id).collect())
            .unwrap_or_default()
    }
}

/// Default policy: pinned origin files are never evicted.
pub struct PinnedOriginPolicy;

impl EvictionPolicy for PinnedOriginPolicy {}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct DeleteOutcome {
    /// Remaining pins (0 when the file was removed).
    pub pins: u64,
    /// The manifest was removed and a tombstone written.
    pub deleted: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct GcReport {
    pub collected_objects: u64,
    pub collected_bytes: u64,
    /// Due entries skipped because they are reserved by an in-flight read/write.
    pub skipped_reserved: u64,
    pub tombstones_pruned: u64,
    /// Sealed packs compacted (live records moved, pack retired) during this run.
    pub packs_compacted: u64,
}

const GC_BATCH: usize = 512;
const FILE_LOG_KEEP: u64 = 100_000;

/// Removes a manifest and its references inside a write transaction.
fn remove_file_txn(t: &mut Tables<'_>, file_id: &Id, tombstone: Option<u64>, ts: u64) -> Result<bool> {
    let Some(rec) = t.get_file(file_id)? else { return Ok(false) };
    let lo = index::mchunk_key(file_id, 0);
    let hi = index::mchunk_key(file_id, u64::MAX);
    let mut occ: std::collections::HashMap<Id, u64> = std::collections::HashMap::new();
    for r in t.mchunks.range::<&[u8; 40]>(&lo..=&hi)? {
        let (_, v) = r?;
        let (cid, _) = index::mchunk_val_decode(v.value());
        *occ.entry(cid).or_insert(0) += 1;
    }
    t.mchunks.retain_in::<&[u8; 40], _>(&lo..=&hi, |_, _| false)?;
    for (cid, k) in occ {
        t.chunk_ref_sub(&cid, k, ts)?;
    }
    t.manifests.remove(file_id)?;
    t.pins.remove(file_id)?;
    if let Some(ms) = tombstone {
        t.tombstones.insert(file_id, ms)?;
    }
    t.meta_add(meta::FILES, -1)?;
    t.meta_add(meta::LOGICAL, -(rec.size as i64))?;
    t.log_event(index::LOG_REMOVE, file_id)?;
    Ok(true)
}

impl Store {
    /// `DELETE /store/files/:id` = unpin. At pin count 0 the manifest is removed and a tombstone
    /// written; objects whose refcount drops to 0 are collected after the grace period.
    /// `Ok(None)` when the file is not stored.
    pub fn delete(&self, file_id: &Id) -> Result<Option<DeleteOutcome>> {
        let ts = now();
        let out = with_write(self, |t| {
            if t.get_file(file_id)?.is_none() {
                return Ok(None);
            }
            let pins = t.pins.get(file_id)?.map(|g| g.value()).unwrap_or(0);
            if pins > 1 {
                t.pins.insert(file_id, pins - 1)?;
                return Ok(Some(DeleteOutcome { pins: pins - 1, deleted: false }));
            }
            remove_file_txn(t, file_id, Some(ts), ts)?;
            Ok(Some(DeleteOutcome { pins: 0, deleted: true }))
        })?;
        self.fail("delete.after_commit")?;
        Ok(out)
    }

    /// Drops a local replica without writing a tombstone (gravity drop / eviction). Pins are
    /// discarded with it; the caller (policy) is responsible for deciding that this is allowed.
    pub fn drop_replica(&self, file_id: &Id) -> Result<bool> {
        let ts = now();
        with_write(self, |t| remove_file_txn(t, file_id, None, ts))
    }

    /// Applies a tombstone received from a peer: records it and removes the local file if its
    /// `created_ms` is older than `deleted_ms` (a newer re-upload wins). Returns whether a file
    /// was removed.
    pub fn apply_tombstone(&self, file_id: &Id, deleted_ms: u64) -> Result<bool> {
        let ts = now();
        with_write(self, |t| {
            let cur = t.tombstones.get(file_id)?.map(|g| g.value()).unwrap_or(0);
            if deleted_ms > cur {
                t.tombstones.insert(file_id, deleted_ms)?;
            }
            match t.get_file(file_id)? {
                Some(rec) if rec.created_ms < deleted_ms => remove_file_txn(t, file_id, None, ts),
                _ => Ok(false),
            }
        })
    }

    /// Marks a file as origin (or not) — used for origin transfer between nodes.
    pub fn set_origin(&self, file_id: &Id, origin: bool) -> Result<bool> {
        with_write(self, |t| {
            let Some(mut rec) = t.get_file(file_id)? else { return Ok(false) };
            rec.origin = origin;
            t.manifests.insert(file_id, rec.encode().as_slice())?;
            Ok(true)
        })
    }

    /// Adds `delta` pins (may be negative; never removes the file — use [`Store::delete`]).
    pub fn add_pins(&self, file_id: &Id, delta: i64) -> Result<Option<u64>> {
        with_write(self, |t| {
            if t.get_file(file_id)?.is_none() {
                return Ok(None);
            }
            let cur = t.pins.get(file_id)?.map(|g| g.value()).unwrap_or(0);
            let next = if delta >= 0 { cur.saturating_add(delta as u64) } else { cur.saturating_sub(delta.unsigned_abs()) };
            if next == 0 {
                t.pins.remove(file_id)?;
            } else {
                t.pins.insert(file_id, next)?;
            }
            Ok(Some(next))
        })
    }

    /// Asks the eviction policy for files to drop until `need` live bytes were released.
    /// Returns the live bytes released.
    pub(crate) fn evict(&self, need: u64) -> Result<u64> {
        let _g = lock(&self.evict_lock);
        let policy = self.eviction_policy();
        let before = self.meta_value(meta::LIVE)?;
        for fid in policy.candidates(self, need) {
            let Some(m) = self.file_meta(&fid)? else { continue };
            if !policy.can_evict(&m) {
                continue;
            }
            if self.drop_replica(&fid)? {
                self.stats.evictions.fetch_add(1, Ordering::Relaxed);
            }
            if before.saturating_sub(self.meta_value(meta::LIVE)?) >= need {
                break;
            }
        }
        Ok(before.saturating_sub(self.meta_value(meta::LIVE)?))
    }

    /// Collects objects that have been unreferenced for at least the grace period and are not
    /// reserved by an in-flight read or write; prunes old tombstones and the inventory log.
    pub fn gc(&self) -> Result<GcReport> {
        self.gc_with_grace(self.cfg.gc_grace.as_millis() as u64)
    }

    /// GC with an explicit grace period (tests / admin).
    pub fn gc_with_grace(&self, grace_ms: u64) -> Result<GcReport> {
        let mut report = GcReport::default();
        loop {
            let ts = now();
            let due: Vec<Id> = {
                let tx = self.db.begin_read()?;
                let q = tx.open_table(index::GC_QUEUE)?;
                let mut v = Vec::new();
                for r in q.range::<&[u8; 32]>(..)? {
                    let (k, enq) = r?;
                    if enq.value().saturating_add(grace_ms) <= ts {
                        v.push(*k.value());
                    }
                }
                v
            };
            if due.is_empty() {
                break;
            }
            let mut progressed = false;
            for batch in due.chunks(GC_BATCH) {
                let (n, bytes, skipped) = self.gc_batch(batch, grace_ms)?;
                report.collected_objects += n;
                report.collected_bytes += bytes;
                report.skipped_reserved += skipped;
                progressed |= n > 0;
            }
            if !progressed || due.len() < GC_BATCH {
                break;
            }
        }
        // sealed packs that became mostly dead are rewritten; retired pack files are deleted after
        // `REACTOR_GC_GRACE_MS` so reads that resolved an old location finish undisturbed
        let c = self.compact_packs(self.cfg.gc_grace.as_millis() as u64)?;
        report.packs_compacted = c.packs_compacted;
        // tombstones older than the TTL; inventory log beyond the retention window
        let ttl = self.cfg.tombstone_ttl.as_millis() as u64;
        let ts = now();
        report.tombstones_pruned = with_write(self, |t| {
            let mut n = 0u64;
            t.tombstones.retain(|_, v| {
                let keep = v.saturating_add(ttl) > ts;
                if !keep {
                    n += 1;
                }
                keep
            })?;
            let version = t.meta_get(meta::INVENTORY_VERSION)?;
            if version > FILE_LOG_KEEP {
                let floor = version - FILE_LOG_KEEP;
                t.file_log.retain_in(..floor, |_, _| false)?;
            }
            Ok(n)
        })?;
        Ok(report)
    }

    /// Deletes one batch: index rows in one transaction, then the files — all while holding the
    /// reservation lock so nobody can reserve (and rely on) an object being deleted.
    fn gc_batch(&self, ids: &[Id], grace_ms: u64) -> Result<(u64, u64, u64)> {
        let reservations = lock(&self.reservations);
        let ts = now();
        let mut skipped = 0u64;
        let deleted: Vec<(Id, ObjectRec)> = with_write(self, |t| {
            let mut out = Vec::new();
            for id in ids {
                let Some(enq) = t.gc.get(id)?.map(|g| g.value()) else { continue };
                if enq.saturating_add(grace_ms) > ts {
                    continue;
                }
                let Some(rec) = t.get_obj(id)? else {
                    t.gc.remove(id)?;
                    continue;
                };
                if rec.refcount != 0 {
                    t.gc.remove(id)?;
                    continue;
                }
                if Store::is_reserved_locked(&reservations, id, &rec) {
                    skipped += 1;
                    continue;
                }
                for m in &rec.members {
                    if let Some(loc) = t.get_loc(m)? {
                        if loc.object == *id {
                            if loc.refs != 0 {
                                return Err(StoreError::Corrupt(format!("live chunk {} in unreferenced object", hex::encode(m))));
                            }
                            t.chunk_loc.remove(m)?;
                            t.access.remove(m)?;
                        }
                    }
                }
                t.objects.remove(id)?;
                t.gc.remove(id)?;
                if let Some(loc) = rec.pack {
                    // its record becomes dead bytes, reclaimed by pack compaction
                    t.pack_unlink(loc, rec.stored_len)?;
                }
                if rec.quarantined() {
                    t.quarantine.remove(id)?;
                    t.meta_add(meta::QUARANTINED, -1)?;
                }
                t.meta_add(meta::PHYSICAL, -(rec.stored_len as i64))?;
                t.meta_add(meta::OBJECTS, -1)?;
                if rec.is_super() {
                    t.meta_add(meta::SUPER, -1)?;
                }
                t.meta_add(meta::GC_OBJECTS, 1)?;
                t.meta_add(meta::GC_BYTES, rec.stored_len as i64)?;
                out.push((*id, rec));
            }
            Ok(out)
        })?;
        self.fail("gc.after_commit")?;
        let mut bytes = 0u64;
        for (id, rec) in &deleted {
            bytes += rec.stored_len;
            if rec.pack.is_none() {
                let _ = std::fs::remove_file(self.object_path(id));
            }
            if rec.quarantined() {
                let _ = std::fs::remove_file(self.quarantine_path(id));
            }
        }
        drop(reservations);
        Ok((deleted.len() as u64, bytes, skipped))
    }
}
