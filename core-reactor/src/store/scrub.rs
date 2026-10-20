//! Background integrity scrub, quarantine and repair (NETWORK_SPEC §2 "Integrity scrub").
//!
//! Each step re-verifies the next slice of objects (in object-id order, wrapping around): file
//! length (or pack record magic / id / length / CRC), blob-v2 decode (CRC), plaintext length and
//! plaintext SHA-256 = object id. A corrupt object is moved to `quarantine/` (a packed one is
//! unlinked from its pack, its record becoming dead bytes), flagged in the index and reported to
//! the quarantine hook so
//! data gravity can re-fetch it from a peer and call `repair_object_raw` / `repair_object_plain`.

use super::index::{self, meta, ObjectRec};
use super::{id_hex, now, sha256, with_write, Id, Reservation, Result, Store, StoreError};
use redb::ReadableDatabase;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Default)]
pub(crate) struct ScrubState {
    cursor: Option<Id>,
    objects_checked: u64,
    bytes_checked: u64,
    corrupt_found: u64,
    passes_completed: u64,
    last_step_ms: u64,
    last_pass_ms: u64,
    pass_progress: u64,
    unverifiable: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ScrubReport {
    pub checked: u64,
    pub bytes: u64,
    pub corrupt: Vec<String>,
    pub wrapped: bool,
    /// Objects that could not be checked (encryption key or dictionary not configured here).
    pub unverifiable: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct ScrubStatus {
    pub objects_checked: u64,
    pub bytes_checked: u64,
    pub corrupt_found: u64,
    pub passes_completed: u64,
    pub pass_progress_objects: u64,
    pub last_step_ms: u64,
    pub last_pass_ms: u64,
    pub quarantined: u64,
    pub unverifiable: u64,
}

impl Store {
    pub(crate) fn quarantine_path(&self, id: &Id) -> PathBuf {
        self.quarantine_dir.join(format!("{}.obj", id_hex(id)))
    }

    /// Flags an object as corrupt, moves its file aside and notifies the hook. Idempotent.
    pub(crate) fn quarantine(&self, id: &Id, reason: &str) {
        if self.is_crashed() {
            return;
        }
        let ts = now();
        let newly = with_write(self, |t| {
            let Some(mut rec) = t.get_obj(id)? else {
                return Ok(None);
            };
            if rec.quarantined() {
                return Ok(None);
            }
            // a packed object's record is marked dead; repair writes a fresh copy elsewhere
            let old = rec.pack.take();
            if let Some(loc) = old {
                t.pack_unlink(loc, rec.stored_len)?;
            }
            rec.flags |= index::FLAG_QUARANTINED;
            t.put_obj(id, &rec)?;
            let mut v = ts.to_le_bytes().to_vec();
            v.extend_from_slice(reason.chars().take(500).collect::<String>().as_bytes());
            t.quarantine.insert(id, v.as_slice())?;
            t.meta_add(meta::QUARANTINED, 1)?;
            Ok(Some((old, rec.stored_len)))
        });
        match newly {
            Ok(Some((old, len))) => {
                match old {
                    // keep a copy of the bad bytes for inspection (the pack itself is immutable)
                    Some(loc) => {
                        if let Some(b) = self.read_packed_unchecked(loc, len) {
                            let _ = std::fs::write(self.quarantine_path(id), b);
                        }
                    }
                    None => {
                        // during an online backup the file stays where the snapshot expects it
                        // (a copy is kept for inspection instead; GC removes both later)
                        match self.maint_gate.try_read() {
                            Ok(_g) => {
                                let _ =
                                    std::fs::rename(self.object_path(id), self.quarantine_path(id));
                            }
                            Err(_) => {
                                let _ =
                                    std::fs::copy(self.object_path(id), self.quarantine_path(id));
                            }
                        }
                    }
                }
                tracing::warn!("quarantined object {}: {}", id_hex(id), reason);
                super::lock(&self.scrub).corrupt_found += 1;
                let hook = self
                    .quarantine_hook
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone();
                if let Some(h) = hook {
                    h(*id);
                }
            }
            Ok(None) => {}
            Err(e) => tracing::warn!("failed to quarantine {}: {}", id_hex(id), e),
        }
    }

    /// Quarantined objects: `(object_id, detected_ms, reason)`.
    pub fn quarantined(&self) -> Result<Vec<(Id, u64, String)>> {
        let tx = self.db.begin_read()?;
        let t = tx.open_table(index::QUARANTINE)?;
        let mut out = Vec::new();
        for r in t.range::<&[u8; 32]>(..)? {
            let (k, v) = r?;
            let b = v.value();
            let ms = if b.len() >= 8 {
                u64::from_le_bytes(b[..8].try_into().unwrap_or([0; 8]))
            } else {
                0
            };
            out.push((
                *k.value(),
                ms,
                String::from_utf8_lossy(b.get(8..).unwrap_or(&[])).to_string(),
            ));
        }
        Ok(out)
    }

    pub(crate) fn scrub_status(&self, quarantined: u64) -> ScrubStatus {
        let s = super::lock(&self.scrub);
        ScrubStatus {
            objects_checked: s.objects_checked,
            bytes_checked: s.bytes_checked,
            corrupt_found: s.corrupt_found,
            passes_completed: s.passes_completed,
            pass_progress_objects: s.pass_progress,
            last_step_ms: s.last_step_ms,
            last_pass_ms: s.last_pass_ms,
            quarantined,
            unverifiable: s.unverifiable,
        }
    }

    /// Verifies the next slice of objects, about `max_bytes` of stored data (at least one object).
    pub fn scrub_step(&self, max_bytes: u64) -> Result<ScrubReport> {
        let cursor = super::lock(&self.scrub).cursor;
        let mut batch: Vec<(Id, ObjectRec)> = Vec::new();
        let mut wrapped = false;
        {
            let tx = self.db.begin_read()?;
            let t = tx.open_table(index::OBJECTS)?;
            let mut budget = 0u64;
            let iter = match &cursor {
                Some(c) => t.range::<&[u8; 32]>((
                    std::ops::Bound::Excluded(c),
                    std::ops::Bound::Unbounded,
                ))?,
                None => t.range::<&[u8; 32]>(..)?,
            };
            for r in iter {
                let (k, v) = r?;
                let rec = ObjectRec::decode(v.value())?;
                budget += rec.stored_len;
                batch.push((*k.value(), rec));
                if budget >= max_bytes {
                    break;
                }
            }
            if budget < max_bytes {
                wrapped = true;
            }
        }
        let mut report = ScrubReport {
            wrapped,
            ..Default::default()
        };
        for (id, rec) in &batch {
            if rec.quarantined() {
                continue;
            }
            let mut res = Reservation::new(self);
            res.add(*id);
            // the object may have been collected since the snapshot
            let Some(cur) = self.object_rec(id)? else {
                continue;
            };
            if cur.quarantined() {
                continue;
            }
            report.checked += 1;
            report.bytes += cur.stored_len;
            match self.verify_object_data(id, &cur) {
                Ok(()) => {}
                Err(super::VerifyFail::Corrupt(reason)) => {
                    self.quarantine(id, &reason);
                    report.corrupt.push(id_hex(id));
                }
                Err(super::VerifyFail::Unavailable(reason)) => {
                    report.unverifiable += 1;
                    super::lock(&self.scrub).unverifiable += 1;
                    tracing::warn!("scrub cannot verify object {}: {}", id_hex(id), reason);
                }
            }
        }
        let mut s = super::lock(&self.scrub);
        s.objects_checked += report.checked;
        s.bytes_checked += report.bytes;
        s.pass_progress += report.checked;
        s.last_step_ms = now();
        s.cursor = batch.last().map(|b| b.0);
        if wrapped {
            s.cursor = None;
            s.passes_completed += 1;
            s.pass_progress = 0;
            s.last_pass_ms = now();
        }
        Ok(report)
    }

    /// Replaces a quarantined (or any) object with plaintext obtained elsewhere (e.g. member chunks
    /// from peers). The plaintext must hash to `object_id`; it is recompressed with the champion
    /// of the object's class and verified.
    pub fn repair_object_plain(&self, object_id: &Id, plain: &[u8]) -> Result<()> {
        if sha256(plain) != *object_id {
            return Err(StoreError::Invalid(
                "repair plaintext does not hash to the object id".into(),
            ));
        }
        let rec = self.object_rec(object_id)?.ok_or(StoreError::NotFound)?;
        if rec.plain_len != plain.len() as u64 {
            return Err(StoreError::Invalid(
                "repair plaintext length mismatch".into(),
            ));
        }
        let enc = self.encoder(super::class_name(rec.class));
        let stored = self.encode_sealed(&enc, object_id, plain)?;
        self.install_repair(object_id, &stored)
    }

    /// Replaces an object with the transport form (blob v2) from a peer
    /// (`GET /cluster/objects/:id`), verified by decoding and hashing, then sealed under this
    /// node's active key.
    pub fn repair_object_raw(&self, object_id: &Id, raw: &[u8]) -> Result<()> {
        let plain = self.decode_object(object_id, raw)?;
        let rec = self.object_rec(object_id)?.ok_or(StoreError::NotFound)?;
        if rec.plain_len != plain.len() as u64 {
            return Err(StoreError::Invalid("repair object length mismatch".into()));
        }
        let stored = self.seal_object(object_id, raw.to_vec());
        self.install_repair(object_id, &stored)
    }

    /// Writes a fresh copy (a new pack record when small, else the object file), then one index
    /// transaction points the object at it and clears the quarantine flag. A previous pack record
    /// becomes dead bytes; a previous object file is deleted once the object lives in a pack.
    fn install_repair(&self, id: &Id, stored: &[u8]) -> Result<()> {
        self.install_stored(id, stored, None).map(|_| ())
    }

    /// Installs new stored bytes for an existing object (repair, rekey). With `expect =
    /// Some((pack, stored_len))` the index row is only repointed if the object is still exactly
    /// there and not quarantined (returns false otherwise; the new copy is then garbage).
    pub(crate) fn install_stored(
        &self,
        id: &Id,
        stored: &[u8],
        expect: Option<(Option<index::PackLoc>, u64)>,
    ) -> Result<bool> {
        // rewrites an object file in place / deletes it: never while a backup copies the snapshot
        let Ok(_gate) = self.maint_gate.try_read() else {
            return Err(StoreError::Busy(
                "an online backup is running; retry when it finished".into(),
            ));
        };
        let mut res = Reservation::new(self);
        res.add(*id);
        let file_in_place = !self.pack_eligible(stored.len());
        let _place = file_in_place
            .then(|| super::lock(&self.place_locks[id[0] as usize % self.place_locks.len()]));
        if let Some((pack, len)) = expect {
            match self.object_rec(id)? {
                Some(r) if r.pack == pack && r.stored_len == len && !r.quarantined() => {}
                _ => return Ok(false),
            }
        }
        let (loc, _pin) = self.place_blob(id, stored)?;
        self.fail("install.after_place")?;
        let new_len = stored.len() as u64;
        let outcome = with_write(self, |t| {
            let mut rec = t.get_obj(id)?.ok_or(StoreError::NotFound)?;
            if let Some((pack, len)) = expect {
                if rec.pack != pack || rec.stored_len != len || rec.quarantined() {
                    return Ok(None);
                }
            }
            let old = rec.stored_len;
            let slot = self.slot_of(stored);
            if slot != rec.key_slot() {
                t.meta_add(&meta::enc_objects(rec.key_slot()), -1)?;
                t.meta_add(&meta::enc_objects(slot), 1)?;
                rec.set_key_slot(slot);
            }
            let q = rec.quarantined();
            if let Some(l) = rec.pack {
                t.pack_unlink(l, old)?;
            }
            let drop_file = rec.pack.is_none() && !q && loc.is_some();
            if let Some(l) = loc {
                t.pack_link(l, new_len)?;
            }
            rec.pack = loc;
            rec.flags &= !index::FLAG_QUARANTINED;
            rec.stored_len = new_len;
            t.put_obj(id, &rec)?;
            t.meta_add(meta::PHYSICAL, new_len as i64 - old as i64)?;
            if rec.refcount > 0 {
                t.meta_add(meta::LIVE, new_len as i64 - old as i64)?;
            }
            if q {
                t.quarantine.remove(id)?;
                t.meta_add(meta::QUARANTINED, -1)?;
            }
            Ok(Some((q, drop_file)))
        })?;
        let Some((was_quarantined, drop_file)) = outcome else {
            return Ok(false);
        };
        if drop_file {
            let _ = std::fs::remove_file(self.object_path(id));
        }
        if was_quarantined {
            let _ = std::fs::remove_file(self.quarantine_path(id));
            tracing::info!("repaired object {}", id_hex(id));
        }
        Ok(true)
    }
}
