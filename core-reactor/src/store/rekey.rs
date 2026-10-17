//! Re-encryption (NETWORK_SPEC §7 "Migration and key rotation").
//!
//! [`Store::rekey`] walks the objects table (index only: the key slot of every row says which key
//! its stored bytes are sealed under) and, for every object that is plaintext or sealed under a
//! key other than the active one: reads it, opens it (AEAD), verifies decode + plaintext SHA-256,
//! seals it under the active key and installs the new copy (new pack record or atomically
//! replaced file, then ONE index transaction that repoints the row only if the object did not
//! change meanwhile). A crash at any point leaves every object readable (old or new copy) and a
//! consistent index; rerunning simply continues with the rows that still need work, so the
//! operation is resumable and idempotent. Afterwards the active pack is sealed and every pack
//! holding dead records (the superseded plaintext / old-key copies) is compacted, and dictionary
//! files are rewrapped.

use super::index::{self, meta, ObjectRec};
use super::{id_hex, Id, Reservation, Result, Store, StoreError};
use redb::ReadableDatabase;
use serde::Serialize;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct RekeyReport {
    /// Objects examined that needed work.
    pub candidates: u64,
    /// Plaintext objects now encrypted.
    pub encrypted: u64,
    /// Objects moved from another key id to the active one.
    pub rewrapped: u64,
    /// Objects that changed while being rewritten (collected, moved, repaired); retried next run.
    pub skipped: u64,
    /// Objects that could not be rewritten (`id: reason`), e.g. key not configured or corrupt.
    pub failed: Vec<String>,
    /// Objects still not under the active key after this run.
    pub remaining: u64,
    pub dicts_rewrapped: u64,
    pub packs_compacted: u64,
}

/// Progress callback payload.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct RekeyProgress {
    pub done: u64,
    pub total: u64,
    pub bytes: u64,
}

const SCAN_BATCH: usize = 1024;

impl Store {
    /// Indexed, non-quarantined objects not sealed under the active key (from the per-slot
    /// counters: every object minus those under the active slot).
    pub fn rekey_remaining(&self) -> Result<u64> {
        let m = self.meta_snapshot()?;
        let total = m.get(meta::OBJECTS).copied().unwrap_or(0);
        let active = if self.active_slot == 0 { 0 } else { m.get(&meta::enc_objects(self.active_slot)).copied().unwrap_or(0) };
        Ok(total.saturating_sub(active))
    }

    /// Encrypts plaintext objects and rewraps objects under other key ids to the active key (see
    /// module docs). `retire_grace_ms` is the delay before compacted packs are deleted (0 when the
    /// store is offline, e.g. `reactor-admin rekey`). `progress` is called after every object.
    pub fn rekey(&self, retire_grace_ms: u64, progress: &mut dyn FnMut(RekeyProgress)) -> Result<RekeyReport> {
        if !self.keys().enabled() {
            return Err(StoreError::Invalid("rekey needs an active master key (REACTOR_MASTER_KEY / REACTOR_MASTER_KEYS + REACTOR_ACTIVE_KEY_ID)".into()));
        }
        let mut report = RekeyReport::default();
        let mut prog = RekeyProgress { total: self.rekey_remaining()?, ..Default::default() };
        let mut failed: std::collections::HashSet<Id> = std::collections::HashSet::new();
        for _pass in 0..3 {
            let mut cursor: Option<Id> = None;
            let skipped_before = report.skipped;
            loop {
                let batch = self.rekey_scan(cursor.as_ref(), &failed)?;
                let Some(last) = batch.last_scanned else { break };
                cursor = Some(last);
                for (id, rec) in batch.items {
                    report.candidates += 1;
                    match self.rekey_object(&id, &rec) {
                        Ok(Some(bytes)) => {
                            if rec.key_slot() == 0 {
                                report.encrypted += 1;
                            } else {
                                report.rewrapped += 1;
                            }
                            prog.done += 1;
                            prog.bytes += bytes;
                        }
                        Ok(None) => report.skipped += 1,
                        // index / process failures stop the run (rerun resumes)
                        Err(e @ (StoreError::Injected(_) | StoreError::Db(_))) => return Err(e),
                        Err(e) => {
                            failed.insert(id);
                            if report.failed.len() < 200 {
                                report.failed.push(format!("{}: {}", id_hex(&id), e));
                            }
                        }
                    }
                    progress(prog);
                }
            }
            if report.skipped == skipped_before {
                break;
            }
        }
        // superseded copies (plaintext / old key) are dead pack records: make them unreachable
        self.seal_active_pack();
        let c = self.compact_packs_with(1.0, retire_grace_ms)?;
        report.packs_compacted = c.packs_compacted;
        if retire_grace_ms == 0 {
            self.delete_retired_packs(true);
        }
        for d in self.engine.dicts.list_ids() {
            match self.engine.dicts.rekey(&d) {
                Ok(true) => report.dicts_rewrapped += 1,
                Ok(false) => {}
                Err(e) => report.failed.push(format!("dict {}: {}", hex::encode(d), e)),
            }
        }
        report.remaining = self.rekey_remaining()?;
        Ok(report)
    }

    fn rekey_scan(&self, after: Option<&Id>, failed: &std::collections::HashSet<Id>) -> Result<ScanBatch> {
        let tx = self.db.begin_read()?;
        let t = tx.open_table(index::OBJECTS)?;
        let iter = match after {
            Some(a) => t.range::<&[u8; 32]>((std::ops::Bound::Excluded(a), std::ops::Bound::Unbounded))?,
            None => t.range::<&[u8; 32]>(..)?,
        };
        let mut out = ScanBatch { items: Vec::new(), last_scanned: None };
        for (n, r) in iter.enumerate() {
            if n >= SCAN_BATCH * 8 || out.items.len() >= SCAN_BATCH {
                break;
            }
            let (k, v) = r?;
            let id = *k.value();
            out.last_scanned = Some(id);
            let rec = ObjectRec::decode(v.value())?;
            if rec.key_slot() != self.active_slot && !rec.quarantined() && !failed.contains(&id) {
                out.items.push((id, rec));
            }
        }
        Ok(out)
    }

    /// Rewrites one object under the active key. `Ok(None)` = it changed meanwhile.
    fn rekey_object(&self, id: &Id, rec: &ObjectRec) -> Result<Option<u64>> {
        let mut res = Reservation::new(self);
        res.add(*id);
        let Some(cur) = self.object_rec(id)? else { return Ok(None) };
        if cur.pack != rec.pack || cur.stored_len != rec.stored_len || cur.quarantined() || cur.key_slot() == self.active_slot {
            return Ok(None);
        }
        let stored = match self.read_stored(id)? {
            Ok(b) => b,
            Err(reason) => {
                self.quarantine(id, &reason);
                return Err(StoreError::Corrupt(reason));
            }
        };
        if rec.pack.is_some() && stored.len() as u64 != rec.stored_len {
            return Ok(None);
        }
        let blob = match self.open_stored(id, &stored) {
            Ok(b) => b.into_owned(),
            Err(e @ StoreError::KeyUnavailable(_)) => return Err(e),
            Err(e) => {
                self.quarantine(id, &e.to_string());
                return Err(e);
            }
        };
        match self.decode_object(id, &blob) {
            Ok(_) => {}
            Err(e @ StoreError::UnknownDict(_)) => return Err(e),
            Err(e) => {
                self.quarantine(id, &e.to_string());
                return Err(e);
            }
        }
        let sealed = self.seal_object(id, blob);
        let len = sealed.len() as u64;
        // a file object's current length on disk (its row may lag after a crash: reconciled at open)
        let expect_len = if rec.pack.is_none() { stored.len() as u64 } else { rec.stored_len };
        if expect_len != rec.stored_len {
            return Ok(None);
        }
        Ok(self.install_stored(id, &sealed, Some((rec.pack, rec.stored_len)))?.then_some(len))
    }
}

struct ScanBatch {
    items: Vec<(Id, ObjectRec)>,
    last_scanned: Option<Id>,
}
