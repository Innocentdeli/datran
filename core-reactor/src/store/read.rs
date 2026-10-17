//! Range-aware verified reads (NETWORK_SPEC §2 "Reads").
//!
//! The manifest is walked in batches (fresh short read transaction per batch, so a slow client
//! never pins an old index snapshot). Chunk ids of a batch are reserved before their locations are
//! looked up, so GC cannot delete an object under a reader. Only objects overlapping the range are
//! read and decoded; consecutive chunks of one super-chunk decode it once. Every chunk's SHA-256 is
//! verified before any of its bytes are handed to the sink.

use super::index::{self, ChunkLoc};
use super::{id_hex, sha256, Id, Reservation, Result, Store, StoreError};
use redb::ReadableDatabase;
use std::sync::atomic::Ordering;
use std::sync::Arc;

const READ_BATCH: usize = 128;

/// What one read did (for metrics and tests).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReadStats {
    pub bytes: u64,
    pub chunks: u64,
    pub objects_decoded: u64,
}

impl Store {
    /// Streams bytes `[start, end)` of a file into `sink` (called with verified slices, at most
    /// one chunk at a time). `sink` returning false cancels the read (`Ok`). Errors:
    /// `NotFound`, `Invalid` (range), `Corrupt` (verification failed; object quarantined).
    pub fn read_range(&self, file_id: &Id, start: u64, end: u64, sink: &mut dyn FnMut(&[u8]) -> bool) -> Result<ReadStats> {
        let meta = self.file_meta(file_id)?.ok_or(StoreError::NotFound)?;
        if start > end || end > meta.size {
            return Err(StoreError::Invalid(format!("range {}..{} outside file of {} bytes", start, end, meta.size)));
        }
        let mut stats = ReadStats::default();
        let mut pos = start;
        let mut cache: Option<(Id, Arc<Vec<u8>>)> = None;
        let mut accessed: Vec<Id> = Vec::new();
        let mut cancelled = false;
        while pos < end && !cancelled {
            // 1. next batch of manifest rows covering pos..
            let rows: Vec<(u64, Id, u32)> = {
                let tx = self.db.begin_read()?;
                let mc = tx.open_table(index::MANIFEST_CHUNKS)?;
                let lo = index::mchunk_key(file_id, 0);
                let at = index::mchunk_key(file_id, pos);
                let first = mc
                    .range::<&[u8; 40]>(&lo..=&at)?
                    .next_back()
                    .transpose()?
                    .map(|(k, _)| index::mchunk_key_offset(k.value()))
                    .ok_or_else(|| StoreError::Corrupt(format!("file {}: no chunk at offset {}", id_hex(file_id), pos)))?;
                let from = index::mchunk_key(file_id, first);
                let to = index::mchunk_key(file_id, end);
                let mut v = Vec::with_capacity(READ_BATCH);
                for r in mc.range::<&[u8; 40]>(&from..&to)? {
                    let (k, val) = r?;
                    let (cid, len) = index::mchunk_val_decode(val.value());
                    v.push((index::mchunk_key_offset(k.value()), cid, len));
                    if v.len() >= READ_BATCH {
                        break;
                    }
                }
                v
            };
            if rows.is_empty() {
                return Err(StoreError::Corrupt(format!("file {}: manifest ends before offset {}", id_hex(file_id), pos)));
            }
            // 2. reserve, then resolve locations
            let mut res = Reservation::new(self);
            let ids: Vec<Id> = rows.iter().map(|r| r.1).collect();
            res.add_all(&ids);
            let locs: Vec<ChunkLoc> = {
                let tx = self.db.begin_read()?;
                let t = tx.open_table(index::CHUNK_LOC)?;
                let mut v = Vec::with_capacity(rows.len());
                for (_, cid, _) in &rows {
                    let loc = t
                        .get(cid)?
                        .map(|g| ChunkLoc::decode(g.value()))
                        .transpose()?
                        .ok_or_else(|| StoreError::Corrupt(format!("chunk {} has no location", id_hex(cid))))?;
                    v.push(loc);
                }
                v
            };
            // 3. decode, verify, emit
            for ((off, cid, len), loc) in rows.iter().zip(locs.iter()) {
                if *off > pos || off + *len as u64 <= pos {
                    return Err(StoreError::Corrupt(format!("file {}: manifest gap at {}", id_hex(file_id), pos)));
                }
                if cache.as_ref().map(|c| c.0) != Some(loc.object) {
                    let plain = self.read_object_plain(&loc.object)?;
                    stats.objects_decoded += 1;
                    cache = Some((loc.object, Arc::new(plain)));
                }
                let plain = &cache.as_ref().map(|c| c.1.clone()).unwrap_or_default();
                let (s, e) = (loc.offset as usize, loc.offset as usize + loc.len as usize);
                if loc.len != *len || e > plain.len() || sha256(&plain[s..e]) != *cid {
                    let reason = format!("chunk {} failed SHA-256 verification", id_hex(cid));
                    self.quarantine(&loc.object, &reason);
                    return Err(StoreError::Corrupt(reason));
                }
                let chunk = &plain[s..e];
                let a = (pos - off) as usize;
                let b = ((end.min(off + *len as u64)) - off) as usize;
                stats.chunks += 1;
                accessed.push(*cid);
                if !sink(&chunk[a..b]) {
                    cancelled = true;
                    break;
                }
                stats.bytes += (b - a) as u64;
                pos = off + *len as u64;
                if pos >= end {
                    break;
                }
            }
            res.release();
        }
        self.stats.reads.fetch_add(1, Ordering::Relaxed);
        self.stats.read_bytes.fetch_add(stats.bytes, Ordering::Relaxed);
        if stats.chunks > stats.objects_decoded {
            self.stats.reads_saved_pending.fetch_add(stats.chunks - stats.objects_decoded, Ordering::Relaxed);
        }
        self.record_access(&accessed);
        self.notify_read(file_id, stats.bytes);
        Ok(stats)
    }

    /// Reads a whole file or `[start, end)` into memory (tests, small files, gravity verification).
    pub fn read_to_vec(&self, file_id: &Id, range: Option<(u64, u64)>) -> Result<Vec<u8>> {
        let (s, e) = match range {
            Some(r) => r,
            None => (0, self.file_meta(file_id)?.ok_or(StoreError::NotFound)?.size),
        };
        let mut out = Vec::with_capacity((e.saturating_sub(s)).min(64 << 20) as usize);
        self.read_range(file_id, s, e, &mut |b| {
            out.extend_from_slice(b);
            true
        })?;
        Ok(out)
    }

    /// Verified plaintext of one chunk (from whatever object holds it).
    pub fn read_chunk(&self, chunk_id: &Id) -> Result<Vec<u8>> {
        let mut res = Reservation::new(self);
        res.add(*chunk_id);
        let loc = {
            let tx = self.db.begin_read()?;
            tx.open_table(index::CHUNK_LOC)?
                .get(chunk_id)?
                .map(|g| ChunkLoc::decode(g.value()))
                .transpose()?
                .ok_or(StoreError::NotFound)?
        };
        let plain = self.read_object_plain(&loc.object)?;
        let (s, e) = (loc.offset as usize, loc.offset as usize + loc.len as usize);
        if e > plain.len() || sha256(&plain[s..e]) != *chunk_id {
            let reason = format!("chunk {} failed SHA-256 verification", id_hex(chunk_id));
            self.quarantine(&loc.object, &reason);
            return Err(StoreError::Corrupt(reason));
        }
        Ok(plain[s..e].to_vec())
    }
}
