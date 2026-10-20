//! Chunked object store + fusion (NETWORK_SPEC §2–§3).

mod common;

use common::*;
use core_reactor::evolution::Engine;
use core_reactor::store::{
    sha256, ChunkEntry, Id, PutOptions, Store, StoreConfig, StoreError, CDC_MAX,
};
use std::collections::HashSet;
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

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
        let mut cfg = StoreConfig::new(dir.path().join("store"));
        cfg.coaccess_min = 4.0;
        Env { dir, engine, cfg }
    }
    fn open(&self) -> Store {
        Store::open(self.cfg.clone(), self.engine.clone()).unwrap()
    }
    /// Every object in its own file (pack files disabled), the layout these tests were written for.
    fn open_files_only(&self) -> Store {
        let mut cfg = self.cfg.clone();
        cfg.pack_threshold = 0;
        Store::open(cfg, self.engine.clone()).unwrap()
    }
}

fn opts() -> PutOptions {
    PutOptions {
        content_type: None,
        sample: false,
    }
}

fn assert_consistent(s: &Store) {
    let r = s.verify_index(true).unwrap();
    assert!(r.ok(), "index inconsistent: {:#?}", r.problems);
}

/// Text with long-range self-similarity: `base` followed by a lightly mutated copy, so chunk ids
/// differ but compressing both together finds long matches.
fn versioned_text(n: usize, seed: u64) -> Vec<u8> {
    let base = text(n, seed);
    let mut copy = base.clone();
    let mut r = Lcg(seed ^ 0xabcdef);
    let mut i = 3000;
    while i < copy.len() {
        copy[i] = b'A' + r.below(26) as u8;
        i += 9000 + r.below(2000) as usize;
    }
    let mut out = base;
    out.extend_from_slice(&copy);
    out
}

fn stat(s: &Store, path: &[&str]) -> f64 {
    let mut v = s.stats().unwrap();
    for p in path {
        v = v[*p].clone();
    }
    v.as_f64()
        .unwrap_or_else(|| panic!("stat {:?} missing", path))
}

/// Deterministic generator that never materializes the file; hashes what it produces.
struct GenReader {
    remaining: u64,
    rng: Lcg,
    hasher: Arc<Mutex<sha2::Sha256>>,
}

impl Read for GenReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        use sha2::Digest;
        let n = (buf.len() as u64).min(self.remaining).min(64 * 1024) as usize;
        let words: [&[u8]; 8] = [
            b"alpha ",
            b"chunk ",
            b"reactor ",
            b"datran ",
            b"store ",
            b"zeta ",
            b"\n",
            b"omega ",
        ];
        let mut i = 0;
        while i < n {
            if self.rng.below(50) == 0 {
                buf[i] = self.rng.next() as u8;
                i += 1;
                continue;
            }
            let w = words[self.rng.below(8) as usize];
            let k = w.len().min(n - i);
            buf[i..i + k].copy_from_slice(&w[..k]);
            i += k;
        }
        self.remaining -= n as u64;
        self.hasher.lock().unwrap().update(&buf[..n]);
        Ok(n)
    }
}

#[test]
fn roundtrip_small_empty_and_reopen() {
    let env = Env::new();
    let s = env.open();
    let empty = s.put_bytes(b"", &opts()).unwrap();
    assert_eq!(empty.file_id, sha256(b""));
    assert_eq!((empty.size, empty.chunks, empty.class), (0, 0, "empty"));
    assert_eq!(s.read_to_vec(&empty.file_id, None).unwrap(), b"");
    let one = s.put_bytes(b"x", &opts()).unwrap();
    assert_eq!(s.read_to_vec(&one.file_id, None).unwrap(), b"x");
    let json = json_logs(300_000, 7);
    let out = s.put_bytes(&json, &opts()).unwrap();
    assert_eq!(out.file_id, sha256(&json));
    assert_eq!(out.class, "text/json");
    assert!(out.chunks >= 2 && out.new_chunks == out.chunks);
    assert!(
        out.stored_bytes < json.len() as u64 / 3,
        "json should compress: {}",
        out.stored_bytes
    );
    assert_eq!(s.read_to_vec(&out.file_id, None).unwrap(), json);
    let m = s.get_manifest(&out.file_id).unwrap().unwrap();
    assert_eq!(m.size, json.len() as u64);
    assert!(m.chunks.iter().all(|c| (c.len as usize) <= CDC_MAX));
    assert!(m.chunks[..m.chunks.len() - 1]
        .iter()
        .all(|c| c.len as usize >= 16 * 1024));
    let v = serde_json::to_value(&m).unwrap();
    assert_eq!(v["file_id"], hex::encode(out.file_id));
    assert!(v["chunks"][0]["id"].is_string() && v["chunks"][0]["len"].is_number());
    assert_consistent(&s);
    drop(s);
    let s = env.open();
    assert_eq!(s.read_to_vec(&out.file_id, None).unwrap(), json);
    assert_eq!(s.read_to_vec(&empty.file_id, None).unwrap(), b"");
    assert_eq!(s.file_meta(&out.file_id).unwrap().unwrap().pins, 1);
    assert_consistent(&s);
    let _ = &env.dir;
}

#[test]
fn large_file_streams_in_and_out() {
    use sha2::Digest;
    let env = Env::new();
    let s = env.open();
    let size = 50u64 << 20;
    let hasher = Arc::new(Mutex::new(sha2::Sha256::new()));
    let gen = GenReader {
        remaining: size,
        rng: Lcg(99),
        hasher: hasher.clone(),
    };
    let t = std::time::Instant::now();
    let out = s.put_reader(gen, &opts()).unwrap();
    let put_s = t.elapsed().as_secs_f64();
    let expect: Id = hasher.lock().unwrap().clone().finalize().into();
    assert_eq!(out.file_id, expect);
    assert_eq!(out.size, size);
    assert!(out.chunks >= 50 * 1024 * 1024 / (256 * 1024) as u64);
    // stream back with an incremental hash; never more than one chunk per sink call
    let mut h = sha2::Sha256::new();
    let mut max_slice = 0usize;
    let t = std::time::Instant::now();
    let st = s
        .read_range(&out.file_id, 0, size, &mut |b| {
            max_slice = max_slice.max(b.len());
            h.update(b);
            true
        })
        .unwrap();
    let get_s = t.elapsed().as_secs_f64();
    let got: Id = h.finalize().into();
    assert_eq!(got, expect);
    assert_eq!(st.bytes, size);
    assert!(max_slice <= CDC_MAX, "slice {}", max_slice);
    println!(
        "50 MiB: put {:.2}s, get {:.2}s, stored {} bytes, {} chunks",
        put_s, get_s, out.stored_bytes, out.chunks
    );
    // cancellation stops early
    let mut seen = 0u64;
    s.read_range(&out.file_id, 0, size, &mut |b| {
        seen += b.len() as u64;
        seen < 1 << 20
    })
    .unwrap();
    assert!(seen < 2 << 20);
}

#[test]
fn dedup_across_files_with_shared_regions() {
    let env = Env::new();
    let s = env.open();
    let shared = text(1_500_000, 42);
    let mk = |a: u64, b: u64| {
        // starts with text: the class (and recipe) comes from the first chunk
        let mut v = text(150_000, a);
        v.extend_from_slice(&shared);
        v.extend_from_slice(&random_bytes(120_000, b));
        v
    };
    let (fa, fb) = (mk(1, 2), mk(3, 4));
    let a = s.put_bytes(&fa, &opts()).unwrap();
    let b = s.put_bytes(&fb, &opts()).unwrap();
    assert!(
        b.dedup_chunks >= 15,
        "dedup {} of {}",
        b.dedup_chunks,
        b.chunks
    );
    assert!(b.stored_bytes < a.stored_bytes / 2);
    let logical = stat(&s, &["logical_bytes"]);
    let unique = stat(&s, &["unique_bytes"]);
    let physical = stat(&s, &["live_physical_bytes"]);
    assert_eq!(logical as usize, fa.len() + fb.len());
    assert!(
        unique < logical * 0.75,
        "unique {} logical {}",
        unique,
        logical
    );
    assert!(physical < unique, "compression on top of dedup");
    assert!(stat(&s, &["dedup_ratio"]) > 1.3);
    // new_bytes = plaintext of newly stored chunks, so per-upload compression is exact under dedup
    assert_eq!((a.new_bytes + b.new_bytes) as f64, unique);
    assert!(b.new_bytes < fb.len() as u64 / 2 && b.new_bytes > 0);
    assert!(a.new_bytes > a.stored_bytes, "text compresses");
    // identical upload = +1 pin, nothing stored
    let again = s.put_bytes(&fa, &opts()).unwrap();
    assert!(again.duplicate && again.stored_bytes == 0 && again.new_bytes == 0 && again.pins == 2);
    assert_eq!(stat(&s, &["logical_bytes"]), logical);
    assert_eq!(s.read_to_vec(&a.file_id, None).unwrap(), fa);
    assert_eq!(s.read_to_vec(&b.file_id, None).unwrap(), fb);
    // repeated chunk inside one file
    let mut rep = random_bytes(300_000, 9);
    let copy = rep.clone();
    rep.extend_from_slice(&copy);
    let r = s.put_bytes(&rep, &opts()).unwrap();
    assert!(r.dedup_chunks >= 1);
    assert_eq!(s.read_to_vec(&r.file_id, None).unwrap(), rep);
    assert_consistent(&s);
}

#[test]
fn range_reads_edge_cases() {
    let env = Env::new();
    let s = env.open();
    let data = json_logs(900_000, 3);
    let n = data.len() as u64;
    let id = s.put_bytes(&data, &opts()).unwrap().file_id;
    let m = s.get_manifest(&id).unwrap().unwrap();
    let mut b0 = 0u64;
    let mut cases = vec![(0, 1), (0, n), (n - 1, n), (5, 6), (0, 0), (n, n)];
    for c in &m.chunks {
        let b = b0 + c.len as u64;
        cases.push((b0, b)); // exactly one chunk
        if b < n {
            cases.push((b - 1, b + 1)); // straddles a boundary
            cases.push((b, b + 1));
        }
        b0 = b;
    }
    let mut r = Lcg(5);
    for _ in 0..200 {
        let a = r.below(n);
        let b = a + r.below(n - a + 1);
        cases.push((a, b));
    }
    for (a, b) in cases {
        let got = s.read_to_vec(&id, Some((a, b))).unwrap();
        assert_eq!(got, &data[a as usize..b as usize], "range {}..{}", a, b);
    }
    // reading one chunk decodes exactly one object
    let st = s.read_range(&id, 10, 20, &mut |_| true).unwrap();
    assert_eq!((st.chunks, st.objects_decoded), (1, 1));
    assert!(matches!(
        s.read_to_vec(&id, Some((0, n + 1))),
        Err(StoreError::Invalid(_))
    ));
    assert!(matches!(
        s.read_to_vec(&id, Some((5, 4))),
        Err(StoreError::Invalid(_))
    ));
    assert!(matches!(
        s.read_to_vec(&[0u8; 32], None),
        Err(StoreError::NotFound)
    ));
}

#[test]
fn delete_tombstone_gc_and_grace() {
    let env = Env::new();
    let s = env.open();
    let shared = text(600_000, 8);
    let mut fa = random_bytes(200_000, 1);
    fa.extend_from_slice(&shared);
    let mut fb = random_bytes(200_000, 2);
    fb.extend_from_slice(&shared);
    let a = s.put_bytes(&fa, &opts()).unwrap();
    let b = s.put_bytes(&fb, &opts()).unwrap();
    s.put_bytes(&fa, &opts()).unwrap(); // pin 2
    let physical0 = stat(&s, &["physical_bytes"]);

    // unpin once: still there
    let d = s.delete(&a.file_id).unwrap().unwrap();
    assert_eq!((d.pins, d.deleted), (1, false));
    assert_eq!(s.read_to_vec(&a.file_id, None).unwrap(), fa);
    // unpin to zero: tombstone, manifest gone, B intact
    let d = s.delete(&a.file_id).unwrap().unwrap();
    assert_eq!((d.pins, d.deleted), (0, true));
    assert!(s.file_meta(&a.file_id).unwrap().is_none());
    assert!(s.tombstone(&a.file_id).unwrap().is_some());
    assert!(s.delete(&a.file_id).unwrap().is_none());
    assert!(matches!(
        s.read_to_vec(&a.file_id, None),
        Err(StoreError::NotFound)
    ));
    assert_eq!(s.read_to_vec(&b.file_id, None).unwrap(), fb);
    assert!(stat(&s, &["gc", "queue_objects"]) >= 1.0);
    assert_consistent(&s);

    // default grace (10 min): nothing collected yet
    let r = s.gc().unwrap();
    assert_eq!(r.collected_objects, 0);
    assert_eq!(stat(&s, &["physical_bytes"]), physical0);

    // re-upload within grace resurrects queued objects without rewriting them
    let again = s.put_bytes(&fa, &opts()).unwrap();
    assert_eq!(again.new_chunks, 0, "queued objects are reused");
    assert_eq!(stat(&s, &["gc", "queue_objects"]), 0.0);
    assert_consistent(&s);
    s.delete(&again.file_id).unwrap();

    // grace elapsed: only A's unique objects go; B still exact
    let r = s.gc_with_grace(0).unwrap();
    assert!(r.collected_objects >= 1 && r.collected_bytes > 0);
    assert!(stat(&s, &["physical_bytes"]) < physical0);
    assert_eq!(stat(&s, &["gc", "queue_objects"]), 0.0);
    assert_eq!(s.read_to_vec(&b.file_id, None).unwrap(), fb);
    assert_consistent(&s);
    // inventory log saw add/remove events
    let (events, version) = s.file_events_since(0, 100).unwrap();
    assert!(events.len() >= 4 && version >= 4);
    // replica drop: no tombstone
    assert!(s.drop_replica(&b.file_id).unwrap());
    assert!(s.tombstone(&b.file_id).unwrap().is_none());
    s.gc_with_grace(0).unwrap();
    assert_eq!(stat(&s, &["objects"]), 0.0);
    assert_eq!(stat(&s, &["physical_bytes"]), 0.0);
    assert_consistent(&s);
}

#[test]
fn capacity_limit_rejects_when_nothing_evictable() {
    let env = Env::new();
    let mut cfg = env.cfg.clone();
    cfg.max_bytes = Some(1_000_000);
    let s = Store::open(cfg, env.engine.clone()).unwrap();
    let a = s.put_bytes(&random_bytes(600_000, 1), &opts()).unwrap();
    let err = s.put_bytes(&random_bytes(600_000, 2), &opts()).unwrap_err();
    assert!(matches!(err, StoreError::Full { .. }), "{}", err);
    assert_eq!(stat(&s, &["full_rejections"]), 1.0);
    // the rejected upload left nothing behind
    assert_consistent(&s);
    assert_eq!(stat(&s, &["files"]), 1.0);
    // dedup'd content still fits; deleting frees live capacity immediately
    assert!(
        s.put_bytes(&random_bytes(600_000, 1), &opts())
            .unwrap()
            .duplicate
    );
    s.delete(&a.file_id).unwrap();
    s.delete(&a.file_id).unwrap();
    assert!(s.put_bytes(&random_bytes(600_000, 2), &opts()).is_ok());
    assert_consistent(&s);
}

#[test]
fn eviction_policy_hook_drops_replicas() {
    let env = Env::new();
    let src = env.open();
    let mut cfg = env.cfg.clone();
    cfg.dir = env.dir.path().join("b");
    cfg.max_bytes = Some(1_000_000);
    let dst = Store::open(cfg, env.engine.clone()).unwrap();
    let data = random_bytes(600_000, 5);
    let fid = src.put_bytes(&data, &opts()).unwrap().file_id;
    import_from(&src, &dst, &fid);
    assert!(!dst.file_meta(&fid).unwrap().unwrap().origin);
    // a replica (not origin, unpinned) is evictable by the default policy
    let other = dst.put_bytes(&random_bytes(600_000, 6), &opts()).unwrap();
    assert!(dst.file_meta(&fid).unwrap().is_none(), "replica evicted");
    assert_eq!(stat(&dst, &["evictions"]), 1.0);
    // origin + pinned is not evictable
    assert!(matches!(
        dst.put_bytes(&random_bytes(600_000, 7), &opts()),
        Err(StoreError::Full { .. })
    ));
    assert_eq!(
        dst.read_to_vec(&other.file_id, None).unwrap().len(),
        600_000
    );
    assert_consistent(&dst);
}

#[test]
fn corruption_is_detected_quarantined_and_repaired() {
    // file layout (the packed variant lives in tests/packs.rs)
    let env = Env::new();
    let s = env.open_files_only();
    let data = json_logs(400_000, 11);
    let id = s.put_bytes(&data, &opts()).unwrap().file_id;
    let refs = s.chunk_refs(&id).unwrap().unwrap().1;
    let hooked = Arc::new(Mutex::new(Vec::<Id>::new()));
    let h2 = hooked.clone();
    s.set_quarantine_hook(Some(Arc::new(move |oid| h2.lock().unwrap().push(oid))));
    let obj_path = |oid: &Id| {
        let h = hex::encode(oid);
        env.cfg
            .dir
            .join("objects")
            .join(&h[..2])
            .join(format!("{}.obj", h))
    };
    // 1. read path detects a flipped payload byte
    let victim = refs[1];
    let p = obj_path(&victim.object_id);
    let mut bytes = std::fs::read(&p).unwrap();
    let last = bytes.len() - 3;
    bytes[last] ^= 0x55;
    std::fs::write(&p, &bytes).unwrap();
    let start = victim.file_offset;
    let err = s.read_to_vec(&id, Some((start, start + 10))).unwrap_err();
    assert!(matches!(err, StoreError::Corrupt(_)), "{}", err);
    assert_eq!(s.quarantined().unwrap().len(), 1);
    assert_eq!(hooked.lock().unwrap().as_slice(), &[victim.object_id]);
    // other ranges still readable
    assert_eq!(s.read_to_vec(&id, Some((0, 100))).unwrap(), &data[..100]);
    // 2. scrub detects a truncated object
    let victim2 = refs[2];
    let p2 = obj_path(&victim2.object_id);
    let b2 = std::fs::read(&p2).unwrap();
    std::fs::write(&p2, &b2[..b2.len() / 2]).unwrap();
    let rep = s.scrub_step(u64::MAX).unwrap();
    assert!(
        rep.corrupt.contains(&hex::encode(victim2.object_id)),
        "{:?}",
        rep
    );
    assert!(rep.wrapped);
    assert_eq!(s.quarantined().unwrap().len(), 2);
    assert_eq!(stat(&s, &["scrub", "quarantined"]), 2.0);
    assert!(stat(&s, &["scrub", "passes_completed"]) >= 1.0);
    // object raw serving refuses quarantined data
    assert!(s.get_object_raw(&victim.object_id).is_err());
    // 3. repair (as data gravity would, from a peer copy of the plaintext / raw object)
    let off = victim.file_offset as usize;
    s.repair_object_plain(&victim.object_id, &data[off..off + victim.len as usize])
        .unwrap();
    let off2 = victim2.file_offset as usize;
    let other_env = Env::new();
    let peer = other_env.open();
    peer.put_bytes(&data, &opts()).unwrap();
    let raw = peer.get_object_raw(&victim2.object_id).unwrap().unwrap();
    assert!(s
        .repair_object_raw(&victim2.object_id, &raw[..raw.len() - 1])
        .is_err());
    s.repair_object_raw(&victim2.object_id, &raw).unwrap();
    let _ = off2;
    assert!(s.quarantined().unwrap().is_empty());
    assert_eq!(s.read_to_vec(&id, None).unwrap(), data);
    assert_eq!(s.scrub_step(u64::MAX).unwrap().corrupt.len(), 0);
    assert_consistent(&s);
}

#[test]
fn concurrent_puts_reads_and_gc() {
    let env = Env::new();
    let s = Arc::new(env.open());
    let same = json_logs(2_000_000, 21);
    let errors = Arc::new(AtomicUsize::new(0));
    let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // a GC thread with zero grace hammering the store the whole time
    let gc = {
        let (s, stop) = (s.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut runs = 0;
            while !stop.load(Ordering::Relaxed) {
                s.gc_with_grace(0).unwrap();
                runs += 1;
            }
            runs
        })
    };
    let mut handles = Vec::new();
    for t in 0..8u64 {
        let (s, same, errors) = (s.clone(), same.clone(), errors.clone());
        handles.push(std::thread::spawn(move || {
            let mine = {
                let mut v = text(300_000, 100 + t);
                v.extend_from_slice(&same[..500_000]);
                v
            };
            for round in 0..3 {
                let a = s.put_bytes(&same, &opts()).unwrap();
                let b = s.put_bytes(&mine, &opts()).unwrap();
                if s.read_to_vec(&a.file_id, None).unwrap() != same
                    || s.read_to_vec(&b.file_id, None).unwrap() != mine
                {
                    errors.fetch_add(1, Ordering::Relaxed);
                }
                if round < 2 {
                    // churn: delete and re-put while others read the shared chunks
                    s.delete(&b.file_id).unwrap();
                }
            }
        }));
    }
    for h in handles {
        h.join().unwrap();
    }
    stop.store(true, Ordering::Relaxed);
    assert!(gc.join().unwrap() > 0);
    assert_eq!(errors.load(Ordering::Relaxed), 0);
    let fid = sha256(&same);
    assert_eq!(s.file_meta(&fid).unwrap().unwrap().pins, 24);
    assert_eq!(s.read_to_vec(&fid, None).unwrap(), same);
    s.gc_with_grace(0).unwrap();
    assert_consistent(&s);
}

/// Files A and B share a 1.2 MB region whose second half is a lightly edited copy of the first.
fn fusion_corpus() -> (Vec<u8>, Vec<u8>) {
    let shared = versioned_text(600_000, 77);
    let mut a = text(200_000, 1);
    a.extend_from_slice(&shared);
    a.extend_from_slice(&text(150_000, 2));
    let mut b = text(180_000, 3);
    b.extend_from_slice(&shared);
    b.extend_from_slice(&text(170_000, 4));
    (a, b)
}

#[test]
fn fusion_structural_signal_measured_gain_and_exact_reads() {
    let env = Env::new();
    let s = env.open();
    let (fa, fb) = fusion_corpus();
    let a = s.put_bytes(&fa, &opts()).unwrap().file_id;
    let b = s.put_bytes(&fb, &opts()).unwrap().file_id;
    let live0 = stat(&s, &["live_physical_bytes"]);
    let rep = s.run_fusion_pass().unwrap();
    println!("fusion report: {:?}", rep);
    assert!(rep.structural_pairs >= 5, "{:?}", rep);
    assert!(rep.fused >= 1, "{:?}", rep);
    for (_, cur, fused, accepted) in &rep.evaluated {
        if *accepted {
            assert!(
                (*fused as f64) <= *cur as f64 * 0.95,
                "accepted without 5% gain"
            );
        }
    }
    assert!(rep.bytes_saved > 0);
    let live1 = stat(&s, &["live_physical_bytes"]);
    assert_eq!(
        live0 - live1,
        rep.bytes_saved as f64,
        "measured saving is real"
    );
    assert!(stat(&s, &["super_chunks"]) >= 1.0);
    assert_eq!(stat(&s, &["fusion", "fusions"]), rep.fused as f64);
    assert_eq!(s.read_to_vec(&a, None).unwrap(), fa);
    assert_eq!(s.read_to_vec(&b, None).unwrap(), fb);
    // ranges through the super-chunk are exact too
    for (x, y) in [
        (200_000u64, 200_100u64),
        (500_000, 900_000),
        (0, fa.len() as u64),
    ] {
        assert_eq!(
            s.read_to_vec(&a, Some((x, y))).unwrap(),
            &fa[x as usize..y as usize]
        );
    }
    s.flush_access().unwrap();
    assert!(stat(&s, &["fusion", "reads_saved"]) > 0.0);
    assert_consistent(&s);
    // old objects are collected after grace; the new layout survives a reopen
    let r = s.gc_with_grace(0).unwrap();
    assert!(r.collected_objects >= 2);
    drop(s);
    let s = env.open();
    assert_eq!(s.read_to_vec(&b, None).unwrap(), fb);
    // a second pass finds nothing new
    assert_eq!(s.run_fusion_pass().unwrap().fused, 0);
    assert_consistent(&s);
}

#[test]
fn fusion_rejects_runs_without_gain() {
    let env = Env::new();
    let s = env.open();
    let shared = random_bytes(800_000, 5);
    let mut fa = random_bytes(100_000, 1);
    fa.extend_from_slice(&shared);
    let mut fb = random_bytes(100_000, 2);
    fb.extend_from_slice(&shared);
    s.put_bytes(&fa, &opts()).unwrap();
    s.put_bytes(&fb, &opts()).unwrap();
    let rep = s.run_fusion_pass().unwrap();
    assert!(
        rep.candidates >= 1 && rep.rejected >= 1 && rep.fused == 0,
        "{:?}",
        rep
    );
    assert_eq!(stat(&s, &["super_chunks"]), 0.0);
    assert_consistent(&s);
}

#[test]
fn fusion_on_access_signal() {
    let env = Env::new();
    let s = env.open();
    let data = versioned_text(400_000, 9);
    let id = s.put_bytes(&data, &opts()).unwrap().file_id;
    // no structural signal (single manifest), no access yet
    assert_eq!(s.run_fusion_pass().unwrap().fused, 0);
    for _ in 0..5 {
        s.read_to_vec(&id, None).unwrap();
    }
    let rep = s.run_fusion_pass().unwrap();
    assert_eq!(rep.structural_pairs, 0);
    assert!(rep.fused >= 1, "{:?}", rep);
    assert_eq!(s.read_to_vec(&id, None).unwrap(), data);
    assert_consistent(&s);
}

#[test]
fn unfuse_when_members_are_read_individually() {
    let env = Env::new();
    let s = env.open();
    let shared = versioned_text(800_000, 31); // 1.6 MB shared run -> super-chunk > 1 MiB
    let mut fa = text(100_000, 1);
    fa.extend_from_slice(&shared);
    let mut fb = text(120_000, 2);
    fb.extend_from_slice(&shared);
    let a = s.put_bytes(&fa, &opts()).unwrap().file_id;
    s.put_bytes(&fb, &opts()).unwrap();
    let rep = s.run_fusion_pass().unwrap();
    assert!(rep.fused >= 1, "{:?}", rep);
    let big = s
        .chunk_refs(&a)
        .unwrap()
        .unwrap()
        .1
        .into_iter()
        .map(|r| r.object_id)
        .find(|o| {
            s.object_meta(o)
                .unwrap()
                .is_some_and(|m| m.members.len() > 1 && m.plain_len > 1 << 20)
        })
        .expect("a super-chunk > 1 MiB");
    // read members one at a time, many times
    let refs = s.chunk_refs(&a).unwrap().unwrap().1;
    for _ in 0..6 {
        for r in refs.iter().filter(|r| r.object_id == big) {
            let st = s
                .read_range(&a, r.file_offset + 5, r.file_offset + 50, &mut |_| true)
                .unwrap();
            assert_eq!(st.chunks, 1);
        }
    }
    let rep = s.run_fusion_pass().unwrap();
    assert_eq!(rep.unfused, 1, "{:?}", rep);
    assert_eq!(rep.fused, 0, "hysteresis: a solo-read run is not re-fused");
    assert_eq!(stat(&s, &["fusion", "unfusions"]), 1.0);
    assert!(s
        .chunk_refs(&a)
        .unwrap()
        .unwrap()
        .1
        .iter()
        .all(|r| r.object_id != big));
    assert_eq!(s.read_to_vec(&a, None).unwrap(), fa);
    assert_consistent(&s);
    s.gc_with_grace(0).unwrap();
    assert!(s.object_meta(&big).unwrap().is_none());
    assert_eq!(s.run_fusion_pass().unwrap().fused, 0);
    assert_consistent(&s);
}

fn crash_at(s: &Store, point: &'static str) {
    s.set_fail_hook(Some(Arc::new(move |p: &str| p == point)));
}

#[test]
fn crash_safety_of_writes() {
    // file layout: temp files / renames (packed writes: tests/packs.rs)
    for point in [
        "write.before_rename",
        "write.before_commit",
        "write.after_commit",
    ] {
        let env = Env::new();
        let s = env.open_files_only();
        let keep = json_logs(300_000, 1);
        let kid = s.put_bytes(&keep, &opts()).unwrap().file_id;
        let mut data = text(700_000, 2);
        data.extend_from_slice(&keep[..100_000]);
        crash_at(&s, point);
        let err = s.put_bytes(&data, &opts()).unwrap_err();
        assert!(matches!(err, StoreError::Injected(p) if p == point));
        drop(s);
        let s = env.open_files_only();
        assert_consistent(&s);
        let fid = sha256(&data);
        let committed = point == "write.after_commit";
        assert_eq!(s.file_meta(&fid).unwrap().is_some(), committed, "{}", point);
        if committed {
            assert_eq!(s.read_to_vec(&fid, None).unwrap(), data);
        } else {
            let swept = stat(&s, &["gc", "startup_orphans_removed"])
                + stat(&s, &["gc", "startup_temp_files_removed"]);
            assert!(swept > 0.0, "{}: crash debris swept", point);
            // the upload can simply be retried
            assert_eq!(
                s.read_to_vec(&s.put_bytes(&data, &opts()).unwrap().file_id, None)
                    .unwrap(),
                data
            );
        }
        assert_eq!(s.read_to_vec(&kid, None).unwrap(), keep, "no data loss");
        assert_consistent(&s);
    }
}

#[test]
fn crash_safety_of_fusion_and_gc() {
    for point in [
        "fuse.after_object",
        "fuse.after_commit",
        "gc.after_commit",
        "delete.after_commit",
        "unfuse.after_objects",
    ] {
        let env = Env::new();
        let s = env.open();
        let (fa, fb) = fusion_corpus();
        let a = s.put_bytes(&fa, &opts()).unwrap().file_id;
        let b = s.put_bytes(&fb, &opts()).unwrap().file_id;
        match point {
            "gc.after_commit" | "delete.after_commit" => {
                let c = s
                    .put_bytes(&random_bytes(400_000, 3), &opts())
                    .unwrap()
                    .file_id;
                if point == "gc.after_commit" {
                    s.delete(&c).unwrap();
                    crash_at(&s, point);
                    assert!(matches!(s.gc_with_grace(0), Err(StoreError::Injected(_))));
                } else {
                    crash_at(&s, point);
                    assert!(matches!(s.delete(&c), Err(StoreError::Injected(_))));
                }
            }
            "unfuse.after_objects" => {
                assert!(s.run_fusion_pass().unwrap().fused >= 1);
                let sup = s
                    .chunk_refs(&a)
                    .unwrap()
                    .unwrap()
                    .1
                    .into_iter()
                    .map(|r| r.object_id)
                    .find(|o| {
                        s.object_meta(o)
                            .unwrap()
                            .is_some_and(|m| m.members.len() > 1)
                    });
                crash_at(&s, point);
                assert!(matches!(
                    s.unfuse(&sup.unwrap()),
                    Err(StoreError::Injected(_))
                ));
            }
            _ => {
                crash_at(&s, point);
                assert!(
                    matches!(s.run_fusion_pass(), Err(StoreError::Injected(_))),
                    "{}",
                    point
                );
            }
        }
        drop(s);
        let s = env.open();
        assert_consistent(&s);
        assert_eq!(s.read_to_vec(&a, None).unwrap(), fa, "{}", point);
        assert_eq!(s.read_to_vec(&b, None).unwrap(), fb, "{}", point);
        if point == "fuse.after_commit" {
            assert!(stat(&s, &["super_chunks"]) >= 1.0);
        }
        if point == "fuse.after_object" {
            assert_eq!(stat(&s, &["super_chunks"]), 0.0);
            // debris = an orphan object file, or (small super-chunk) an uncommitted pack tail
            let debris = stat(&s, &["gc", "startup_orphans_removed"])
                + stat(&s, &["packs", "startup_truncated_bytes"]);
            assert!(debris >= 1.0);
        }
        // the store keeps working: fusion + GC complete normally after the crash
        s.run_fusion_pass().unwrap();
        s.gc_with_grace(0).unwrap();
        assert_eq!(s.read_to_vec(&a, None).unwrap(), fa);
        assert_consistent(&s);
    }
}

fn import_from(src: &Store, dst: &Store, fid: &Id) {
    let manifest = src.get_manifest(fid).unwrap().unwrap();
    let refs = src.chunk_refs(fid).unwrap().unwrap().1;
    let mut imp = dst.begin_import(manifest).unwrap();
    let mut objs: Vec<Id> = refs.iter().map(|r| r.object_id).collect();
    objs.dedup();
    let mut seen = HashSet::new();
    for o in objs {
        if !seen.insert(o) || imp.is_complete() {
            continue;
        }
        let meta = src.object_meta(&o).unwrap().unwrap();
        let raw = src.get_object_raw(&o).unwrap().unwrap();
        let members: Vec<ChunkEntry> = meta.members.clone();
        imp.add_object(&o, &raw, &members).unwrap();
    }
    assert!(
        imp.is_complete(),
        "missing {:?}",
        imp.missing_chunks().len()
    );
    imp.commit().unwrap();
}

#[test]
fn replica_import_api_for_gravity() {
    let env = Env::new();
    let src = env.open();
    let (fa, fb) = fusion_corpus();
    let a = src.put_bytes(&fa, &opts()).unwrap().file_id;
    let b = src.put_bytes(&fb, &opts()).unwrap().file_id;
    assert!(src.run_fusion_pass().unwrap().fused >= 1); // imports include super-chunks
    let mut cfg = env.cfg.clone();
    cfg.dir = env.dir.path().join("replica");
    let dst = Store::open(cfg, env.engine.clone()).unwrap();
    import_from(&src, &dst, &a);
    let meta = dst.file_meta(&a).unwrap().unwrap();
    assert!(!meta.origin && meta.pins == 0);
    assert_eq!(dst.read_to_vec(&a, None).unwrap(), fa);
    assert_eq!(dst.get_manifest(&a).unwrap(), src.get_manifest(&a).unwrap());
    // second file: shared objects already present → fewer objects needed; plain-chunk path
    let manifest = src.get_manifest(&b).unwrap().unwrap();
    let mut imp = dst.begin_import(manifest.clone()).unwrap();
    let missing = imp.missing_chunks();
    assert!(missing.len() < manifest.chunks.len());
    for id in &missing {
        let plain = src.read_chunk(id).unwrap();
        assert!(imp.add_chunk(id, &plain).unwrap());
    }
    // bad input is rejected
    assert!(imp.add_chunk(&[1; 32], b"nope").is_err());
    imp.commit().unwrap();
    assert_eq!(dst.read_to_vec(&b, None).unwrap(), fb);
    assert_consistent(&dst);
    // incomplete import refuses to commit; manifest that lies about its id is rejected
    let mut bad = src.get_manifest(&a).unwrap().unwrap();
    bad.file_id = [7; 32];
    let other_env = Env::new();
    let empty = other_env.open();
    let imp = empty.begin_import(bad.clone()).unwrap();
    assert!(imp.commit().is_err());
    let mut imp = empty.begin_import(bad).unwrap();
    for c in src.get_manifest(&a).unwrap().unwrap().chunks {
        imp.add_chunk(&c.id, &src.read_chunk(&c.id).unwrap())
            .unwrap();
    }
    assert!(matches!(imp.commit(), Err(StoreError::Invalid(_))));
    assert_consistent(&empty);
    assert_eq!(
        empty.stats().unwrap()["objects"],
        0,
        "aborted import left nothing behind"
    );
    // tombstone from a peer beats the older replica
    assert!(dst.apply_tombstone(&a, u64::MAX / 2).unwrap());
    assert!(dst.file_meta(&a).unwrap().is_none());
    assert_consistent(&dst);
}

#[test]
fn evolution_sampling_follows_header() {
    let env = Env::new();
    let s = env.open();
    let json = json_logs(100_000, 4);
    s.put_bytes(
        &json,
        &PutOptions {
            content_type: Some("application/json".into()),
            sample: false,
        },
    )
    .unwrap();
    assert_eq!(env.engine.sample_count("text/json"), 0);
    s.put_bytes(
        &json_logs(100_000, 5),
        &PutOptions {
            content_type: Some("application/json".into()),
            sample: true,
        },
    )
    .unwrap();
    assert_eq!(env.engine.sample_count("text/json"), 1);
    // after evolution, new objects use the champion recipe and still read back exactly
    s.put_bytes(&json_logs(120_000, 6), &PutOptions::default())
        .unwrap();
    env.engine.run_generation("text/json").unwrap();
    let data = json_logs(200_000, 8);
    let id = s.put_bytes(&data, &opts()).unwrap().file_id;
    assert_eq!(s.read_to_vec(&id, None).unwrap(), data);
    let _ = Duration::from_secs(0);
}
