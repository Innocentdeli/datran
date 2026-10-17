//! Pack files for small objects (NETWORK_SPEC §2 "Pack files").

mod common;

use common::*;
use core_reactor::evolution::Engine;
use core_reactor::store::{sha256, Id, PutOptions, Store, StoreConfig, StoreError};
use std::io::{Seek, SeekFrom, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

struct Env {
    dir: tempfile::TempDir,
    engine: Arc<Engine>,
    cfg: StoreConfig,
}

impl Env {
    fn new() -> Env {
        let dir = tempfile::tempdir().unwrap();
        let mut ec = test_config(&dir.path().join("evo"), 1);
        ec.persist = false;
        let engine = Arc::new(Engine::new(ec));
        let cfg = StoreConfig::new(dir.path().join("store"));
        Env { dir, engine, cfg }
    }
    fn open(&self) -> Store {
        Store::open(self.cfg.clone(), self.engine.clone()).unwrap()
    }
}

fn opts() -> PutOptions {
    PutOptions { content_type: None, sample: false }
}

fn assert_consistent(s: &Store) {
    for deep in [false, true] {
        let r = s.verify_index(deep).unwrap();
        assert!(r.ok(), "index inconsistent (deep={}): {:#?}", deep, r.problems);
    }
}

fn stat(s: &Store, path: &[&str]) -> f64 {
    let mut v = s.stats().unwrap();
    for p in path {
        v = v[*p].clone();
    }
    v.as_f64().unwrap_or_else(|| panic!("stat {:?} missing", path))
}

fn crash_at(s: &Store, point: &'static str) {
    s.set_fail_hook(Some(Arc::new(move |p: &str| p == point)));
}

/// Objects referenced by a file, deduplicated, in manifest order.
fn objects_of(s: &Store, fid: &Id) -> Vec<Id> {
    let mut v: Vec<Id> = s.chunk_refs(fid).unwrap().unwrap().1.into_iter().map(|r| r.object_id).collect();
    v.dedup();
    v
}

/// XORs `mask` into the byte at `offset` of `path` without truncating the file.
fn flip(path: &std::path::Path, offset: u64, mask: u8) {
    let mut f = std::fs::OpenOptions::new().read(true).write(true).open(path).unwrap();
    let mut b = [0u8; 1];
    f.seek(SeekFrom::Start(offset)).unwrap();
    std::io::Read::read_exact(&mut f, &mut b).unwrap();
    f.seek(SeekFrom::Start(offset)).unwrap();
    f.write_all(&[b[0] ^ mask]).unwrap();
}

fn pack_files(env: &Env) -> usize {
    std::fs::read_dir(env.cfg.dir.join("packs")).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".pack")).count()
}

#[test]
fn packed_put_get_range_reopen_and_stats() {
    let env = Env::new();
    let s = env.open();
    let mut files: Vec<(Id, Vec<u8>)> = Vec::new();
    for i in 0..30u64 {
        let d = text(1_000 + 1_000 * i as usize, i);
        files.push((s.put_bytes(&d, &opts()).unwrap().file_id, d));
    }
    for d in [Vec::new(), b"x".to_vec(), json_logs(300_000, 3), random_bytes(700_000, 4)] {
        files.push((s.put_bytes(&d, &opts()).unwrap().file_id, d));
    }
    // small objects are packed, large (incompressible ≥ 128 KiB) ones keep their own file
    let (mut packed, mut filed) = (0, 0);
    for (fid, _) in &files {
        for o in objects_of(&s, fid) {
            let at = s.object_storage(&o).unwrap().unwrap();
            match at.pack {
                Some(_) => {
                    packed += 1;
                    assert!(at.len < 128 * 1024);
                }
                None => {
                    filed += 1;
                    assert!(at.len >= 128 * 1024 && at.path.exists());
                }
            }
        }
    }
    assert!(packed >= 30 && filed >= 1, "packed {} filed {}", packed, filed);
    assert_eq!(stat(&s, &["packs", "packed_objects"]), packed as f64);
    assert_eq!(stat(&s, &["packs", "dead_bytes"]), 0.0);
    assert_eq!(stat(&s, &["packs", "packs"]), 1.0);
    assert!(stat(&s, &["packs", "live_bytes"]) > 0.0);
    let v = s.stats().unwrap()["packs"].clone();
    for k in [
        "enabled", "threshold_bytes", "max_pack_bytes", "compact_live_ratio", "packs", "sealed_packs", "active_pack", "packed_objects", "bytes",
        "live_bytes", "dead_bytes", "compactions", "compaction_moved_objects", "compaction_reclaimed_bytes", "retired_pending_delete", "open_handles",
        "appends", "fsyncs", "rotations", "startup_truncated_bytes", "startup_removed_packs",
    ] {
        assert!(!v[k].is_null(), "packs.{} missing: {}", k, v);
    }
    assert_eq!(v["enabled"], true);
    println!("packs stats: {}", v);
    // full and range reads (incl. ranges straddling packed / file objects)
    let check = |s: &Store| {
        for (fid, d) in &files {
            assert_eq!(&s.read_to_vec(fid, None).unwrap(), d);
            let n = d.len() as u64;
            let mut r = Lcg(n);
            for _ in 0..20 {
                if n == 0 {
                    break;
                }
                let a = r.below(n);
                let b = a + r.below(n - a + 1);
                assert_eq!(s.read_to_vec(fid, Some((a, b))).unwrap(), &d[a as usize..b as usize]);
            }
        }
    };
    check(&s);
    for (fid, _) in files.iter().skip(30) {
        for o in objects_of(&s, fid) {
            assert_eq!(s.decode_object(&o, &s.get_object_raw(&o).unwrap().unwrap()).unwrap().len() as u64, s.object_meta(&o).unwrap().unwrap().plain_len);
        }
    }
    assert_consistent(&s);
    drop(s);
    let s = env.open();
    check(&s);
    assert_eq!(stat(&s, &["packs", "startup_truncated_bytes"]), 0.0);
    // appends after a reopen continue in the same pack
    let more = text(5_000, 999);
    let fid = s.put_bytes(&more, &opts()).unwrap().file_id;
    assert_eq!(s.read_to_vec(&fid, None).unwrap(), more);
    assert_eq!(stat(&s, &["packs", "packs"]), 1.0);
    assert_consistent(&s);
    let _ = &env.dir;
}

#[test]
fn concurrent_small_puts_share_one_pack_fsync_per_batch() {
    let env = Env::new();
    let s = Arc::new(env.open());
    let mut handles = Vec::new();
    for t in 0..16u64 {
        let s = s.clone();
        handles.push(std::thread::spawn(move || {
            for i in 0..10u64 {
                let d = text(3_000 + i as usize * 100, t * 100 + i);
                let out = s.put_bytes(&d, &opts()).unwrap();
                assert_eq!(s.read_to_vec(&out.file_id, None).unwrap(), d);
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    let (batches, jobs, max_batch) = s.group_commit_stats();
    let fsyncs = stat(&s, &["packs", "fsyncs"]);
    println!("batches {} jobs {} max_batch {} pack fsyncs {}", batches, jobs, max_batch, fsyncs);
    assert_eq!(jobs, 160);
    assert!(fsyncs <= batches as f64, "at most one pack fsync per batch");
    assert!(max_batch > 1, "concurrent writers were batched");
    assert_eq!(stat(&s, &["packs", "packed_objects"]), 160.0);
    assert_consistent(&s);
}

#[test]
fn crash_with_torn_pack_tail_is_truncated_on_startup() {
    for point in ["pack.after_append", "pack.before_commit"] {
        let env = Env::new();
        let s = env.open();
        let keep = json_logs(200_000, 1);
        let kid = s.put_bytes(&keep, &opts()).unwrap().file_id;
        let data = text(300_000, 2);
        crash_at(&s, point);
        let err = s.put_bytes(&data, &opts()).unwrap_err();
        assert!(matches!(err, StoreError::Injected(p) if p == point), "{}", err);
        drop(s);
        let s = env.open();
        assert!(stat(&s, &["packs", "startup_truncated_bytes"]) > 0.0, "{}: uncommitted tail truncated", point);
        assert!(s.file_meta(&sha256(&data)).unwrap().is_none());
        assert_eq!(s.read_to_vec(&kid, None).unwrap(), keep, "no data loss");
        assert_consistent(&s);
        // the upload can simply be retried
        let fid = s.put_bytes(&data, &opts()).unwrap().file_id;
        assert_eq!(s.read_to_vec(&fid, None).unwrap(), data);
        assert_consistent(&s);
        drop(s);
        // a torn record (half a header plus junk) at the end of the active pack
        let active = env.open().active_pack().unwrap();
        let path = env.cfg.dir.join("packs").join(format!("{:016x}.pack", active));
        let len = std::fs::metadata(&path).unwrap().len();
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(b"REC1\x01\x02\x03torn-garbage").unwrap();
        drop(f);
        let s = env.open();
        assert_eq!(stat(&s, &["packs", "startup_truncated_bytes"]), 19.0);
        assert_eq!(std::fs::metadata(&path).unwrap().len(), len);
        assert_eq!(s.read_to_vec(&fid, None).unwrap(), data);
        let more = text(4_000, 3);
        assert_eq!(s.read_to_vec(&s.put_bytes(&more, &opts()).unwrap().file_id, None).unwrap(), more);
        assert_consistent(&s);
    }
}

/// `n` small files with distinct content (one chunk each).
fn small_files(n: u64, seed: u64) -> Vec<Vec<u8>> {
    (0..n).map(|i| text(12_000 + (i as usize % 7) * 500, seed + i)).collect()
}

#[test]
fn rotation_and_compaction_with_concurrent_reads() {
    let mut env = Env::new();
    env.cfg.pack_max_bytes = 64 * 1024;
    // retired packs are deleted immediately, so racing readers also hit vanished pack files
    env.cfg.gc_grace = std::time::Duration::ZERO;
    let s = Arc::new(env.open());
    let files = small_files(120, 10);
    let ids: Vec<Id> = files.iter().map(|d| s.put_bytes(d, &opts()).unwrap().file_id).collect();
    let packs0 = stat(&s, &["packs", "packs"]);
    assert!(packs0 >= 4.0, "rotated into several packs: {}", packs0);
    assert_eq!(stat(&s, &["packs", "sealed_packs"]), packs0 - 1.0);
    assert_eq!(stat(&s, &["packs", "rotations"]), packs0);
    // keep every 4th file; readers hammer the kept ones while GC + compaction run
    let kept: Vec<(Id, Vec<u8>)> = ids.iter().zip(&files).enumerate().filter(|(i, _)| i % 4 == 0).map(|(_, (id, d))| (*id, d.clone())).collect();
    for (i, id) in ids.iter().enumerate() {
        if i % 4 != 0 {
            s.delete(id).unwrap();
        }
    }
    let kept = Arc::new(kept);
    let stop = Arc::new(AtomicBool::new(false));
    let (errors, reads) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
    let mut readers = Vec::new();
    for t in 0..4usize {
        let (s, kept, stop, errors, reads) = (s.clone(), kept.clone(), stop.clone(), errors.clone(), reads.clone());
        readers.push(std::thread::spawn(move || {
            let mut i = t;
            while !stop.load(Ordering::Relaxed) || i < t + kept.len() {
                let (id, d) = &kept[i % kept.len()];
                match s.read_to_vec(id, None) {
                    Ok(v) if &v == d => {}
                    other => {
                        eprintln!("reader {}: bad read {:?}", t, other.map(|v| v.len()));
                        errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
                reads.fetch_add(1, Ordering::Relaxed);
                i += 1;
            }
        }));
    }
    std::thread::sleep(std::time::Duration::from_millis(20));
    // objects collected → sealed packs ~25 % live → live records moved, old packs deleted
    let r = s.gc_with_grace(0).unwrap();
    let reads_during = reads.load(Ordering::Relaxed);
    std::thread::sleep(std::time::Duration::from_millis(20));
    stop.store(true, Ordering::Relaxed);
    for h in readers {
        h.join().unwrap();
    }
    println!("gc {:?}, reads {} (before end of gc {})", r, reads.load(Ordering::Relaxed), reads_during);
    assert_eq!(errors.load(Ordering::Relaxed), 0, "reads stayed exact during compaction");
    assert!(r.packs_compacted >= 1 && r.collected_objects >= 80, "{:?}", r);
    assert_eq!(s.quarantined().unwrap().len(), 0, "no false quarantine");
    assert!(stat(&s, &["packs", "compactions"]) >= r.packs_compacted as f64);
    assert!(stat(&s, &["packs", "compaction_moved_objects"]) >= 1.0);
    assert_eq!(stat(&s, &["packs", "retired_pending_delete"]), 0.0);
    assert!((pack_files(&env) as f64) < packs0, "retired pack files deleted");
    // what is left is mostly live: dead bytes ≤ live bytes
    assert!(stat(&s, &["packs", "dead_bytes"]) <= stat(&s, &["packs", "live_bytes"]), "{}", s.stats().unwrap()["packs"]);
    for (id, d) in kept.iter() {
        assert_eq!(&s.read_to_vec(id, None).unwrap(), d);
    }
    assert_consistent(&s);
    drop(s);
    let s = env.open();
    for (id, d) in kept.iter() {
        assert_eq!(&s.read_to_vec(id, None).unwrap(), d);
    }
    assert_consistent(&s);
}

#[test]
fn compaction_retire_grace_and_crash_points() {
    // default retire grace (REACTOR_GC_GRACE_MS, 10 min): old pack files outlive the compaction
    let mut env = Env::new();
    env.cfg.pack_max_bytes = 64 * 1024;
    let s = env.open();
    let files = small_files(60, 20);
    let ids: Vec<Id> = files.iter().map(|d| s.put_bytes(d, &opts()).unwrap().file_id).collect();
    let before = pack_files(&env);
    for (i, id) in ids.iter().enumerate() {
        if i % 4 != 0 {
            s.delete(id).unwrap();
        }
    }
    let r = s.gc_with_grace(0).unwrap();
    assert!(r.packs_compacted >= 1, "{:?}", r);
    let pending = stat(&s, &["packs", "retired_pending_delete"]);
    assert_eq!(pending, r.packs_compacted as f64);
    assert!(pack_files(&env) >= before, "retired files kept during the grace period");
    assert_consistent(&s); // retired files are not orphans
    for (i, (id, d)) in ids.iter().zip(&files).enumerate() {
        if i % 4 == 0 {
            assert_eq!(&s.read_to_vec(id, None).unwrap(), d);
        }
    }
    drop(s);
    let s = env.open();
    assert_eq!(stat(&s, &["packs", "startup_removed_packs"]), pending, "retired packs removed at restart");
    assert!(pack_files(&env) < before);
    assert_consistent(&s);
    drop(s);

    for point in ["compact.after_copy", "compact.after_commit"] {
        let mut env = Env::new();
        env.cfg.pack_max_bytes = 64 * 1024;
        let s = env.open();
        let files = small_files(60, 40);
        let ids: Vec<Id> = files.iter().map(|d| s.put_bytes(d, &opts()).unwrap().file_id).collect();
        for (i, id) in ids.iter().enumerate() {
            if i % 4 != 0 {
                s.delete(id).unwrap();
            }
        }
        crash_at(&s, point);
        assert!(matches!(s.gc_with_grace(0), Err(StoreError::Injected(p)) if p == point), "{}", point);
        drop(s);
        let s = env.open();
        assert_consistent(&s);
        if point == "compact.after_copy" {
            assert!(stat(&s, &["packs", "startup_truncated_bytes"]) > 0.0, "copied records were uncommitted");
        } else {
            assert!(stat(&s, &["packs", "startup_removed_packs"]) >= 1.0, "retired pack removed at startup");
        }
        for (i, (id, d)) in ids.iter().zip(&files).enumerate() {
            if i % 4 == 0 {
                assert_eq!(&s.read_to_vec(id, None).unwrap(), d, "{}", point);
            }
        }
        // compaction completes normally after the crash
        s.gc_with_grace(0).unwrap();
        assert!(stat(&s, &["packs", "compactions"]) >= 1.0);
        assert_consistent(&s);
    }
}

#[test]
fn packed_object_quarantine_and_repair() {
    let env = Env::new();
    let s = env.open();
    let data = json_logs(400_000, 11);
    let id = s.put_bytes(&data, &opts()).unwrap().file_id;
    let refs = s.chunk_refs(&id).unwrap().unwrap().1;
    let hooked = Arc::new(Mutex::new(Vec::<Id>::new()));
    let h2 = hooked.clone();
    s.set_quarantine_hook(Some(Arc::new(move |oid| h2.lock().unwrap().push(oid))));
    let packed0 = stat(&s, &["packs", "packed_objects"]);
    // 1. read path detects a flipped payload byte inside a pack record
    let victim = refs[1];
    let at = s.object_storage(&victim.object_id).unwrap().unwrap();
    assert!(at.pack.is_some());
    flip(&at.path, at.offset + at.len - 3, 0x55);
    let start = victim.file_offset;
    let err = s.read_to_vec(&id, Some((start, start + 10))).unwrap_err();
    assert!(matches!(err, StoreError::Corrupt(_)), "{}", err);
    assert_eq!(s.quarantined().unwrap().len(), 1);
    assert_eq!(hooked.lock().unwrap().as_slice(), &[victim.object_id]);
    assert!(s.object_meta(&victim.object_id).unwrap().unwrap().quarantined);
    // the record is now dead bytes
    assert_eq!(stat(&s, &["packs", "packed_objects"]), packed0 - 1.0);
    assert!(stat(&s, &["packs", "dead_bytes"]) >= at.len as f64);
    assert!(s.get_object_raw(&victim.object_id).is_err());
    assert_eq!(s.read_to_vec(&id, Some((0, 100))).unwrap(), &data[..100]);
    assert_consistent(&s);
    // 2. scrub detects a damaged record header (object id byte)
    let victim2 = refs[2];
    let at2 = s.object_storage(&victim2.object_id).unwrap().unwrap();
    flip(&at2.path, at2.offset - 20, 0xff);
    let rep = s.scrub_step(u64::MAX).unwrap();
    assert!(rep.corrupt.contains(&hex::encode(victim2.object_id)), "{:?}", rep);
    assert_eq!(s.quarantined().unwrap().len(), 2);
    // 3. repair: plaintext (recompressed) and raw from a peer; both write fresh pack records
    let off = victim.file_offset as usize;
    s.repair_object_plain(&victim.object_id, &data[off..off + victim.len as usize]).unwrap();
    let other_env = Env::new();
    let peer = other_env.open();
    peer.put_bytes(&data, &opts()).unwrap();
    let raw = peer.get_object_raw(&victim2.object_id).unwrap().unwrap();
    assert!(s.repair_object_raw(&victim2.object_id, &raw[..raw.len() - 1]).is_err());
    s.repair_object_raw(&victim2.object_id, &raw).unwrap();
    for (v, old) in [(victim, &at), (victim2, &at2)] {
        let now = s.object_storage(&v.object_id).unwrap().unwrap();
        assert!(now.pack.is_some() && now.offset > old.offset, "fresh record appended");
    }
    assert!(s.quarantined().unwrap().is_empty());
    assert_eq!(stat(&s, &["packs", "packed_objects"]), packed0);
    assert_eq!(s.read_to_vec(&id, None).unwrap(), data);
    assert_eq!(s.scrub_step(u64::MAX).unwrap().corrupt.len(), 0);
    assert_consistent(&s);
    drop(s);
    let s = env.open();
    assert_eq!(s.read_to_vec(&id, None).unwrap(), data);
    assert_consistent(&s);
}

#[test]
fn large_upload_flushes_small_objects_early_and_imports_verify_them() {
    // 40 MiB of random bytes: most chunks are < 128 KiB stored → > 16 MiB of small objects in one
    // upload, so the writer appends (and fsyncs) them early instead of buffering them all
    let env = Env::new();
    let src = env.open();
    let data = random_bytes(40 << 20, 77);
    let fid = src.put_bytes(&data, &opts()).unwrap().file_id;
    assert!(stat(&src, &["packs", "appends"]) >= 2.0, "early flush + leader append");
    assert_eq!(src.read_to_vec(&fid, None).unwrap(), data);
    assert_consistent(&src);
    // replica import of packed objects: verified by reading early-flushed, not yet indexed records
    let mut cfg = env.cfg.clone();
    cfg.dir = env.dir.path().join("replica");
    let dst = Store::open(cfg.clone(), env.engine.clone()).unwrap();
    let manifest = src.get_manifest(&fid).unwrap().unwrap();
    let mut imp = dst.begin_import(manifest).unwrap();
    for o in objects_of(&src, &fid) {
        let meta = src.object_meta(&o).unwrap().unwrap();
        imp.add_object(&o, &src.get_object_raw(&o).unwrap().unwrap(), &meta.members).unwrap();
    }
    let out = imp.commit().unwrap();
    assert!(!out.duplicate);
    assert!(stat(&dst, &["packs", "appends"]) >= 2.0);
    assert_eq!(dst.read_to_vec(&fid, None).unwrap(), data);
    assert_consistent(&dst);
    drop(dst);
    // a crash before the index commit leaves only an uncommitted (truncated) pack tail
    let env2 = Env::new();
    let s = env2.open();
    let keep = text(10_000, 1);
    let kid = s.put_bytes(&keep, &opts()).unwrap().file_id;
    crash_at(&s, "write.before_commit");
    assert!(matches!(s.put_bytes(&data, &opts()), Err(StoreError::Injected(_))));
    drop(s);
    let s = env2.open();
    assert!(stat(&s, &["packs", "startup_truncated_bytes"]) > 16.0 * 1024.0 * 1024.0);
    assert!(s.file_meta(&fid).unwrap().is_none());
    assert_eq!(s.read_to_vec(&kid, None).unwrap(), keep);
    assert_consistent(&s);
}

#[test]
fn migration_from_index_without_packs() {
    let env = Env::new();
    // a store written with packing disabled (every object a file) ...
    let mut cfg0 = env.cfg.clone();
    cfg0.pack_threshold = 0;
    let s0 = Store::open(cfg0, env.engine.clone()).unwrap();
    let old: Vec<Vec<u8>> = (0..10).map(|i| text(8_000 + i * 1_000, 70 + i as u64)).chain([json_logs(300_000, 5)]).collect();
    let old_ids: Vec<Id> = old.iter().map(|d| s0.put_bytes(d, &opts()).unwrap().file_id).collect();
    assert_eq!(stat(&s0, &["packs", "packs"]), 0.0);
    drop(s0);
    // ... whose index predates the `packs` table entirely
    {
        let db = redb::Database::create(env.cfg.dir.join("index.redb")).unwrap();
        let tx = db.begin_write().unwrap();
        assert!(tx.delete_table(core_reactor::store::index::PACKS).unwrap());
        tx.commit().unwrap();
    }
    // reopened with packing on: old objects stay file-based and readable, new ones are packed
    let s = env.open();
    assert_consistent(&s);
    for (id, d) in old_ids.iter().zip(&old) {
        assert_eq!(&s.read_to_vec(id, None).unwrap(), d);
        for o in objects_of(&s, id) {
            assert!(s.object_storage(&o).unwrap().unwrap().pack.is_none());
        }
    }
    let new: Vec<Vec<u8>> = (0..10).map(|i| text(6_000 + i * 700, 900 + i as u64)).collect();
    let new_ids: Vec<Id> = new.iter().map(|d| s.put_bytes(d, &opts()).unwrap().file_id).collect();
    for id in &new_ids {
        for o in objects_of(&s, id) {
            assert!(s.object_storage(&o).unwrap().unwrap().pack.is_some());
        }
    }
    // a file mixing an old (file) chunk and new (packed) data reads back exactly
    let mut mixed = old[0].clone();
    mixed.extend_from_slice(&new[0]);
    let mid = s.put_bytes(&mixed, &opts()).unwrap().file_id;
    assert_eq!(s.read_to_vec(&mid, None).unwrap(), mixed);
    assert_consistent(&s);
    // old objects are collected as files, packed ones as dead pack bytes
    let first_old_obj = objects_of(&s, &old_ids[3])[0];
    let old_path = s.object_storage(&first_old_obj).unwrap().unwrap().path;
    assert!(old_path.exists());
    s.delete(&old_ids[3]).unwrap();
    s.delete(&new_ids[3]).unwrap();
    s.gc_with_grace(0).unwrap();
    assert!(!old_path.exists());
    assert!(stat(&s, &["packs", "dead_bytes"]) > 0.0);
    assert_consistent(&s);
    drop(s);
    let s = env.open();
    for (id, d) in old_ids.iter().zip(&old).chain(new_ids.iter().zip(&new)).filter(|(id, _)| **id != old_ids[3] && **id != new_ids[3]) {
        assert_eq!(&s.read_to_vec(id, None).unwrap(), d);
    }
    assert_consistent(&s);
}
