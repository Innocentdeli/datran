//! Chunk fusion (NETWORK_SPEC §3): access tracking, fusing chunk runs into super-chunk objects,
//! and unfusing super-chunks whose members are mostly read individually.
//!
//! Signals:
//! - structural: adjacent chunk pairs `(c_i, c_{i+1})` that occur in ≥ 2 distinct manifests
//!   (only chunks with refs ≥ 2 can qualify, which keeps the pair table small);
//! - access: both chunks of an adjacent pair have a decayed co-access count ≥ `coaccess_min`
//!   (a chunk is co-accessed when it is read in a request that read other chunks too).
//!
//! Access counting is cheap: readers add to an in-memory map (one lock per request); the map is
//! flushed periodically into the `access` table with exponential decay.
//!
//! Rewrite: write the super-chunk object (verified; a pack record when small, else a file; fsync)
//! → one index transaction that re-checks every member, repoints `chunk_loc` and moves refcounts
//! → old objects are collected by GC after the grace period. A crash before the commit leaves an
//! orphan file (swept at startup) or an uncommitted pack tail (truncated at startup); after the
//! commit the old objects are already queued for GC.

use super::index::{self, meta, AccessRec, ChunkLoc, ObjectRec};
use super::{class_code, class_name, id_hex, lock, now, sha256, with_write, Id, Reservation, Result, Store};
use redb::{ReadableDatabase, ReadableTable};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Mutex;

/// Flush the in-memory access map early when it grows beyond this many chunks.
const ACCESS_MAP_MAX: usize = 262_144;
/// Cap on the structural pair table per pass.
const MAX_PAIRS: usize = 2_000_000;

#[derive(Default)]
pub(crate) struct AccessTracker {
    /// chunk → (co, solo) increments since the last flush.
    pending: Mutex<HashMap<Id, (f64, f64)>>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
pub struct FusionReport {
    pub structural_pairs: u64,
    pub candidates: u64,
    pub fused: u64,
    pub rejected: u64,
    pub skipped: u64,
    /// Sum of (current objects − super-chunk) stored bytes over accepted fusions.
    pub bytes_saved: u64,
    pub unfused: u64,
    /// Per evaluated candidate: (chunks, current stored bytes, fused stored bytes, accepted).
    pub evaluated: Vec<(usize, u64, u64, bool)>,
}

struct Candidate {
    chunks: Vec<(Id, u32)>,
    access_linked: bool,
}

impl Store {
    /// Records the chunks one request read (co-access when ≥ 2 chunks).
    pub(crate) fn record_access(&self, chunks: &[Id]) {
        if chunks.is_empty() {
            return;
        }
        let co = chunks.len() >= 2;
        let need_flush = {
            let mut m = lock(&self.access.pending);
            for c in chunks {
                let e = m.entry(*c).or_insert((0.0, 0.0));
                if co {
                    e.0 += 1.0;
                } else {
                    e.1 += 1.0;
                }
            }
            m.len() > ACCESS_MAP_MAX
        };
        if need_flush {
            if let Err(e) = self.flush_access() {
                eprintln!("[store] access flush failed: {}", e);
            }
        }
    }

    /// Merges in-memory access counters into the `access` table (decayed) and persists the
    /// reads-saved metric.
    pub fn flush_access(&self) -> Result<()> {
        let pending = std::mem::take(&mut *lock(&self.access.pending));
        let saved = self.stats.reads_saved_pending.swap(0, Ordering::Relaxed);
        if pending.is_empty() && saved == 0 {
            return Ok(());
        }
        let ts = now();
        let hl = self.cfg.access_half_life.as_millis() as u64;
        with_write(self, |t| {
            for (id, (co, solo)) in &pending {
                // only chunks that are still indexed
                if t.chunk_loc.get(id)?.is_none() {
                    continue;
                }
                let cur = t.access.get(id)?.map(|g| AccessRec::decode(g.value())).transpose()?.unwrap_or_default();
                let mut d = cur.decayed(ts, hl);
                d.co += co;
                d.solo += solo;
                d.last_ms = ts;
                t.access.insert(id, d.encode().as_slice())?;
            }
            if saved > 0 {
                t.meta_add(meta::READS_SAVED, saved as i64)?;
            }
            Ok(())
        })
    }

    /// Decayed access counters of a chunk (after flushing).
    pub fn access_counts(&self, chunk: &Id) -> Result<AccessRec> {
        let tx = self.db.begin_read()?;
        let rec = tx.open_table(index::ACCESS)?.get(chunk)?.map(|g| AccessRec::decode(g.value())).transpose()?.unwrap_or_default();
        Ok(rec.decayed(now(), self.cfg.access_half_life.as_millis() as u64))
    }

    /// One fusion pass: find candidates from both signals, measure, fuse accepted runs, then
    /// consider unfusing. Only one pass runs at a time.
    pub fn run_fusion_pass(&self) -> Result<FusionReport> {
        let _g = lock(&self.fusion_lock);
        self.flush_access()?;
        let mut report = FusionReport::default();
        let ts = now();
        let hl = self.cfg.access_half_life.as_millis() as u64;
        let min = self.cfg.coaccess_min;

        // access signal + unfuse inputs
        let mut co_hot: HashSet<Id> = HashSet::new();
        let mut access: HashMap<Id, AccessRec> = HashMap::new();
        {
            let tx = self.db.begin_read()?;
            for r in tx.open_table(index::ACCESS)?.range::<&[u8; 32]>(..)? {
                let (k, v) = r?;
                let a = AccessRec::decode(v.value())?.decayed(ts, hl);
                if a.co >= min {
                    co_hot.insert(*k.value());
                }
                if a.co + a.solo >= 0.5 {
                    access.insert(*k.value(), a);
                }
            }
        }

        let candidates = self.find_candidates(&co_hot, &access, &mut report)?;
        report.candidates = candidates.len() as u64;
        for c in candidates {
            self.stats.fusion_candidates.fetch_add(1, Ordering::Relaxed);
            match self.fuse_candidate(&c)? {
                FuseResult::Fused { current, fused } => {
                    report.fused += 1;
                    report.bytes_saved += current.saturating_sub(fused);
                    report.evaluated.push((c.chunks.len(), current, fused, true));
                }
                FuseResult::Rejected { current, fused } => {
                    report.rejected += 1;
                    self.stats.fusion_rejected.fetch_add(1, Ordering::Relaxed);
                    report.evaluated.push((c.chunks.len(), current, fused, false));
                }
                FuseResult::Skipped => report.skipped += 1,
            }
        }
        report.unfused = self.unfuse_pass(&access)?;
        self.stats.fusion_last_ms.store(now(), Ordering::Relaxed);
        Ok(report)
    }

    fn find_candidates(&self, co_hot: &HashSet<Id>, access: &HashMap<Id, AccessRec>, report: &mut FusionReport) -> Result<Vec<Candidate>> {
        let tx = self.db.begin_read()?;
        let mc = tx.open_table(index::MANIFEST_CHUNKS)?;
        let locs = tx.open_table(index::CHUNK_LOC)?;
        let objects = tx.open_table(index::OBJECTS)?;
        let shared = |id: &Id| -> Result<bool> {
            Ok(locs.get(id)?.map(|g| ChunkLoc::decode(g.value())).transpose()?.is_some_and(|l| l.refs >= 2))
        };

        // pass 1: structural pair counts over distinct manifests
        let mut pairs: HashMap<(Id, Id), (u32, Id)> = HashMap::new();
        let mut prev: Option<(Id, Id, bool)> = None; // (file, chunk, shared)
        for r in mc.range::<&[u8; 40]>(..)? {
            let (k, v) = r?;
            let mut fid = [0u8; 32];
            fid.copy_from_slice(&k.value()[..32]);
            let (cid, _) = index::mchunk_val_decode(v.value());
            let sh = shared(&cid)?;
            if let Some((pf, pc, psh)) = prev {
                if pf == fid && psh && sh {
                    let full = pairs.len() >= MAX_PAIRS;
                    match pairs.get_mut(&(pc, cid)) {
                        Some(e) => {
                            if e.1 != fid {
                                e.0 += 1;
                                e.1 = fid;
                            }
                        }
                        None if !full => {
                            pairs.insert((pc, cid), (1, fid));
                        }
                        None => {}
                    }
                }
            }
            prev = Some((fid, cid, sh));
        }
        pairs.retain(|_, v| v.0 >= 2);
        report.structural_pairs = pairs.len() as u64;
        if pairs.is_empty() && co_hot.is_empty() {
            return Ok(Vec::new());
        }

        // pass 2: maximal linked runs per manifest
        let single = |id: &Id| -> Result<Option<Id>> {
            let Some(loc) = locs.get(id)?.map(|g| ChunkLoc::decode(g.value())).transpose()? else { return Ok(None) };
            let Some(o) = objects.get(&loc.object)?.map(|g| ObjectRec::decode(g.value())).transpose()? else { return Ok(None) };
            Ok((!o.is_super() && !o.quarantined()).then_some(loc.object))
        };
        let max_run = self.cfg.fuse_max_run as u64;
        let min = self.cfg.coaccess_min;
        let mut out: Vec<Candidate> = Vec::new();
        let mut used: HashSet<Id> = HashSet::new();
        let mut run: Vec<(Id, u32)> = Vec::new();
        let mut run_bytes = 0u64;
        let mut run_access = true;
        let mut run_ids: HashSet<Id> = HashSet::new();
        let mut cur_file: Option<Id> = None;
        let emit = |run: &mut Vec<(Id, u32)>, access_linked: bool, out: &mut Vec<Candidate>, used: &mut HashSet<Id>| -> Result<()> {
            // hysteresis with unfuse: never fuse a run whose chunks are mostly read individually
            let (solo, co) = run.iter().filter_map(|(c, _)| access.get(c)).fold((0.0, 0.0), |a, x| (a.0 + x.solo, a.1 + x.co));
            let solo_dominated = solo >= min && solo > co;
            if run.len() >= 2 && !solo_dominated && !run.iter().any(|(c, _)| used.contains(c)) {
                let mut objs = HashSet::new();
                let mut ok = true;
                for (c, _) in run.iter() {
                    match single(c)? {
                        Some(o) => {
                            objs.insert(o);
                        }
                        None => ok = false,
                    }
                }
                if ok && objs.len() >= 2 {
                    used.extend(run.iter().map(|(c, _)| *c));
                    out.push(Candidate { chunks: run.clone(), access_linked });
                }
            }
            run.clear();
            Ok(())
        };
        for r in mc.range::<&[u8; 40]>(..)? {
            if out.len() >= self.cfg.fuse_max_candidates {
                break;
            }
            let (k, v) = r?;
            let mut fid = [0u8; 32];
            fid.copy_from_slice(&k.value()[..32]);
            let (cid, len) = index::mchunk_val_decode(v.value());
            let same_file = cur_file == Some(fid);
            let link = same_file
                && run.last().is_some_and(|(p, _)| {
                    let structural = pairs.contains_key(&(*p, cid));
                    let accessed = co_hot.contains(p) && co_hot.contains(&cid);
                    structural || accessed
                });
            let link_access = run.last().is_some_and(|(p, _)| co_hot.contains(p) && co_hot.contains(&cid));
            if !link || run_bytes + len as u64 > max_run || run_ids.contains(&cid) {
                emit(&mut run, run_access, &mut out, &mut used)?;
                run_ids.clear();
                run_bytes = 0;
                run_access = true;
            } else {
                run_access &= link_access;
            }
            cur_file = Some(fid);
            run.push((cid, len));
            run_ids.insert(cid);
            run_bytes += len as u64;
        }
        emit(&mut run, run_access, &mut out, &mut used)?;
        Ok(out)
    }

    fn fuse_candidate(&self, c: &Candidate) -> Result<FuseResult> {
        let mut res = Reservation::new(self);
        let ids: Vec<Id> = c.chunks.iter().map(|x| x.0).collect();
        res.add_all(&ids);
        // current locations (must still be live single-chunk objects)
        let mut current: Vec<(ChunkLoc, ObjectRec)> = Vec::with_capacity(ids.len());
        {
            let tx = self.db.begin_read()?;
            let locs = tx.open_table(index::CHUNK_LOC)?;
            let objects = tx.open_table(index::OBJECTS)?;
            for id in &ids {
                let Some(loc) = locs.get(id)?.map(|g| ChunkLoc::decode(g.value())).transpose()? else { return Ok(FuseResult::Skipped) };
                let Some(o) = objects.get(&loc.object)?.map(|g| ObjectRec::decode(g.value())).transpose()? else {
                    return Ok(FuseResult::Skipped);
                };
                if loc.refs == 0 || o.is_super() || o.quarantined() {
                    return Ok(FuseResult::Skipped);
                }
                current.push((loc, o));
            }
        }
        let mut distinct: HashMap<Id, u64> = HashMap::new();
        for (loc, o) in &current {
            distinct.insert(loc.object, o.stored_len);
        }
        if distinct.len() < 2 {
            return Ok(FuseResult::Skipped);
        }
        let current_sum: u64 = distinct.values().sum();
        // plaintext of the run, every chunk verified
        let mut plain = Vec::with_capacity(c.chunks.iter().map(|x| x.1 as usize).sum());
        for (id, (loc, _)) in ids.iter().zip(current.iter()) {
            let obj = self.read_object_plain(&loc.object)?;
            let (s, e) = (loc.offset as usize, loc.offset as usize + loc.len as usize);
            if e > obj.len() || sha256(&obj[s..e]) != *id {
                self.quarantine(&loc.object, "chunk failed verification during fusion");
                return Ok(FuseResult::Skipped);
            }
            plain.extend_from_slice(&obj[s..e]);
        }
        let class = class_name(current[0].1.class);
        let enc = self.encoder(class);
        let super_id = sha256(&plain);
        let blob = self.encode_sealed(&enc, &super_id, &plain)?;
        let fused = blob.len() as u64;
        let structural_ok = (fused as f64) <= current_sum as f64 * (1.0 - self.cfg.fuse_min_gain);
        let access_ok = c.access_linked && fused <= current_sum;
        if !(structural_ok || access_ok) {
            return Ok(FuseResult::Rejected { current: current_sum, fused });
        }
        res.add(super_id);
        res.created(super_id);
        let existing = self.object_rec(&super_id)?;
        let reuse = existing.as_ref().is_some_and(|o| !o.quarantined());
        // small super-chunks go into the active pack (pinned until the commit below)
        let (loc, _pin) = if reuse { (None, super::pack::PackPin::none(self)) } else { self.place_blob(&super_id, &blob)? };
        self.fail("fuse.after_object")?;
        let ts = now();
        let committed = with_write(self, |t| {
            // re-check: every member still where we read it, still live
            for (id, (loc, _)) in ids.iter().zip(current.iter()) {
                match t.get_loc(id)? {
                    Some(l) if l.object == loc.object && l.refs > 0 => {}
                    _ => return Ok(false),
                }
            }
            if t.get_obj(&super_id)?.is_none() {
                t.insert_object(
                    &super_id,
                    &ObjectRec {
                        stored_len: fused,
                        plain_len: plain.len() as u64,
                        refcount: 0,
                        created_ms: ts,
                        class: class_code(class),
                        flags: self.new_object_flags(),
                        members: ids.clone(),
                        lens: current.iter().map(|(l, _)| l.len).collect(),
                        pack: loc,
                    },
                )?;
            }
            let mut off = 0u32;
            for id in &ids {
                let old = t.get_loc(id)?.ok_or_else(|| super::StoreError::Corrupt("chunk vanished".into()))?;
                let new = ChunkLoc { object: super_id, offset: off, len: old.len, refs: old.refs };
                t.put_loc(id, &new)?;
                t.obj_ref_inc(&super_id)?;
                t.obj_ref_dec(&old.object, ts)?;
                off += old.len;
            }
            t.meta_add(meta::FUSIONS, 1)?;
            t.meta_add(meta::FUSION_SAVED, current_sum.saturating_sub(fused) as i64)?;
            Ok(true)
        })?;
        self.fail("fuse.after_commit")?;
        if !committed {
            return Ok(FuseResult::Skipped);
        }
        Ok(FuseResult::Fused { current: current_sum, fused })
    }

    /// Splits super-chunks > `unfuse_min_bytes` whose members are mostly read individually.
    fn unfuse_pass(&self, access: &HashMap<Id, AccessRec>) -> Result<u64> {
        let mut targets = Vec::new();
        {
            let tx = self.db.begin_read()?;
            for r in tx.open_table(index::OBJECTS)?.range::<&[u8; 32]>(..)? {
                let (k, v) = r?;
                let o = ObjectRec::decode(v.value())?;
                if !o.is_super() || o.quarantined() || o.refcount == 0 || o.plain_len <= self.cfg.unfuse_min_bytes {
                    continue;
                }
                let (mut solo, mut co) = (0.0, 0.0);
                for m in &o.members {
                    if let Some(a) = access.get(m) {
                        solo += a.solo;
                        co += a.co;
                    }
                }
                if solo >= self.cfg.coaccess_min && solo > co {
                    targets.push(*k.value());
                }
            }
        }
        let mut n = 0;
        for id in targets {
            if self.unfuse(&id)? {
                n += 1;
            }
        }
        Ok(n)
    }

    /// Rewrites every live member of super-chunk `id` as its own object and repoints them.
    pub fn unfuse(&self, id: &Id) -> Result<bool> {
        let mut res = Reservation::new(self);
        res.add(*id);
        let Some(rec) = self.object_rec(id)? else { return Ok(false) };
        if !rec.is_super() || rec.quarantined() {
            return Ok(false);
        }
        res.add_all(&rec.members);
        let plain = self.read_object_plain(id)?;
        let live: Vec<(Id, ChunkLoc)> = {
            let tx = self.db.begin_read()?;
            let locs = tx.open_table(index::CHUNK_LOC)?;
            let mut v = Vec::new();
            for m in &rec.members {
                if let Some(l) = locs.get(m)?.map(|g| ChunkLoc::decode(g.value())).transpose()? {
                    if l.object == *id && l.refs > 0 {
                        v.push((*m, l));
                    }
                }
            }
            v
        };
        let enc = self.encoder(class_name(rec.class));
        let mut new_objects: Vec<(Id, u64, u64, Option<super::index::PackLoc>)> = Vec::new();
        let mut pins = super::pack::PackPin::none(self);
        for (m, l) in &live {
            let (s, e) = (l.offset as usize, l.offset as usize + l.len as usize);
            if e > plain.len() || sha256(&plain[s..e]) != *m {
                self.quarantine(id, "member failed verification during unfuse");
                return Ok(false);
            }
            if self.object_rec(m)?.is_some_and(|o| !o.quarantined() && o.plain_len == l.len as u64) {
                continue; // an object with exactly this plaintext exists (e.g. awaiting GC)
            }
            let blob = self.encode_sealed(&enc, m, &plain[s..e])?;
            res.created(*m);
            let (loc, pin) = self.place_blob(m, &blob)?;
            pins.absorb(pin);
            new_objects.push((*m, blob.len() as u64, l.len as u64, loc));
        }
        self.fail("unfuse.after_objects")?;
        let ts = now();
        let class = rec.class;
        let done = with_write(self, |t| {
            for (m, _) in &live {
                match t.get_loc(m)? {
                    Some(cur) if cur.object == *id => {}
                    _ => return Ok(false),
                }
            }
            for (m, stored, plain_len, loc) in &new_objects {
                if t.get_obj(m)?.is_none() {
                    t.insert_object(
                        m,
                        &ObjectRec {
                            stored_len: *stored,
                            plain_len: *plain_len,
                            refcount: 0,
                            created_ms: ts,
                            class,
                            flags: self.new_object_flags(),
                            members: vec![*m],
                            lens: vec![*plain_len as u32],
                            pack: *loc,
                        },
                    )?;
                }
            }
            for (m, _) in &live {
                let cur = t.get_loc(m)?.ok_or_else(|| super::StoreError::Corrupt("chunk vanished".into()))?;
                if t.get_obj(m)?.is_none() {
                    // reserved, so it cannot have been collected; abort the transaction
                    return Err(super::StoreError::Corrupt(format!("object {} vanished during unfuse", id_hex(m))));
                }
                t.put_loc(m, &ChunkLoc { object: *m, offset: 0, len: cur.len, refs: cur.refs })?;
                if cur.refs > 0 {
                    t.obj_ref_inc(m)?;
                    t.obj_ref_dec(id, ts)?;
                }
            }
            t.meta_add(meta::UNFUSIONS, 1)?;
            Ok(true)
        })?;
        drop(pins);
        if done {
            eprintln!("[store] unfused super-chunk {} into {} objects", id_hex(id), live.len());
        }
        Ok(done)
    }
}

enum FuseResult {
    Fused { current: u64, fused: u64 },
    Rejected { current: u64, fused: u64 },
    Skipped,
}
