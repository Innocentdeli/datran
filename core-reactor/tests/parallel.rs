//! Multi-core compression: parallel store ingest (shared worker pool, ordered staging, bounded
//! in-flight bytes) and multithreaded zstd for large `/compress` bodies.

mod common;

use common::*;
use core_reactor::codec::{self, Codec, DictId, EncodeParams, Filter, HEADER_LEN};
use core_reactor::evolution::Engine;
use core_reactor::recipe::Recipe;
use core_reactor::store::{
    sha256, PutOptions, PutOutcome, Store, StoreConfig, StoreError, CDC_MAX,
};
use std::sync::Arc;

fn opts() -> PutOptions {
    PutOptions {
        content_type: None,
        sample: false,
    }
}

struct Env {
    _dir: tempfile::TempDir,
    cfg: StoreConfig,
    engine: Arc<Engine>,
}

impl Env {
    /// `threads` = `compress_threads` (1 = sequential), `cap` = in-flight bytes per upload.
    fn new(threads: usize, cap: u64, pack_threshold: Option<usize>) -> Env {
        let dir = tempfile::tempdir().unwrap();
        let mut ec = test_config(&dir.path().join("evo"), 7);
        ec.persist = false;
        let engine = Arc::new(Engine::new(ec));
        let mut cfg = StoreConfig::new(dir.path().join("store"));
        cfg.compress_threads = threads;
        cfg.ingest_inflight_bytes = cap;
        cfg.fusion = false;
        if let Some(t) = pack_threshold {
            cfg.pack_threshold = t;
        }
        Env {
            _dir: dir,
            cfg,
            engine,
        }
    }
    fn open(&self) -> Store {
        Store::open(self.cfg.clone(), self.engine.clone()).unwrap()
    }
}

fn stat(s: &Store, path: &[&str]) -> f64 {
    let mut v = s.stats().unwrap();
    for p in path {
        v = v[*p].clone();
    }
    v.as_f64().unwrap_or(0.0)
}

fn assert_consistent(s: &Store) {
    let r = s.verify_index(true).unwrap();
    assert!(r.ok(), "index inconsistent: {:#?}", r.problems);
}

/// Mixed corpus with intra-file duplicate chunks (repeated MiB-sized blocks, both compressible
/// and incompressible, so identical chunks are in flight at the same time).
fn corpora() -> Vec<(&'static str, Vec<u8>)> {
    let mut dup = Vec::new();
    let block = text(1 << 20, 11);
    let rnd = random_bytes(700_000, 12);
    for i in 0..3 {
        dup.extend_from_slice(&block);
        dup.extend_from_slice(&rnd);
        dup.extend_from_slice(&json_logs(200_000, 20 + i));
    }
    let mut mixed = Vec::new();
    for i in 0..6u64 {
        mixed.extend_from_slice(&f32_sensor(60_000, i));
        mixed.extend_from_slice(&random_bytes(150_000, 30 + i));
        mixed.extend_from_slice(&text(250_000, 40 + i));
    }
    vec![
        ("empty", Vec::new()),
        ("tiny", b"hello parallel world".to_vec()),
        ("text", text(3 << 20, 1)),
        ("json", json_logs(2 << 20, 2)),
        ("random", random_bytes(3 << 20, 3)),
        ("zeros", vec![0u8; 2 << 20]),
        ("dup", dup),
        ("mixed", mixed),
    ]
}

/// Everything observable about a stored upload except timestamps.
fn snapshot(s: &Store, o: &PutOutcome) -> String {
    let (meta, refs) = s.chunk_refs(&o.file_id).unwrap().unwrap();
    let mut out = format!(
        "{} {} {} {}\n",
        meta.size, meta.chunks, meta.class, meta.pins
    );
    for r in refs {
        let om = s.object_meta(&r.object_id).unwrap().unwrap();
        out.push_str(&format!(
            "{} {} @{} -> {}+{} ({} / {})\n",
            hex::encode(r.id),
            r.len,
            r.file_offset,
            hex::encode(r.object_id),
            r.object_offset,
            om.stored_len,
            om.plain_len
        ));
    }
    out
}

fn run_corpus(
    threads: usize,
    cap: u64,
    pack_threshold: Option<usize>,
) -> (Vec<PutOutcome>, Vec<String>, String) {
    let env = Env::new(threads, cap, pack_threshold);
    let s = env.open();
    let mut outs = Vec::new();
    let mut snaps = Vec::new();
    // first pass, then the whole corpus again (dedup against the index), then once more with a
    // prefix (partial dedup)
    for round in 0..3 {
        for (name, d) in corpora() {
            let data = if round == 2 {
                [b"prefix-".as_slice(), &d].concat()
            } else {
                d.clone()
            };
            let o = s.put_bytes(&data, &opts()).unwrap();
            assert_eq!(o.file_id, sha256(&data), "{}", name);
            assert_eq!(s.read_to_vec(&o.file_id, None).unwrap(), data, "{}", name);
            snaps.push(snapshot(&s, &o));
            outs.push(o);
        }
    }
    assert_consistent(&s);
    let st = s.stats().unwrap();
    let totals = format!(
        "{} {} {} {} {} {}",
        st["files"],
        st["objects"],
        st["physical_bytes"],
        st["live_physical_bytes"],
        st["unique_bytes"],
        st["packs"]["packed_objects"]
    );
    if threads > 1 {
        assert!(
            stat(&s, &["ingest", "pool_chunks"]) > 0.0,
            "parallel path used"
        );
    } else {
        assert_eq!(
            stat(&s, &["ingest", "pool_chunks"]),
            0.0,
            "sequential path used"
        );
    }
    drop(s);
    drop(env);
    (outs, snaps, totals)
}

#[test]
fn parallel_ingest_is_identical_to_sequential() {
    for packs in [None, Some(0)] {
        let (seq, seq_snaps, seq_tot) = run_corpus(1, 64 << 20, packs);
        for (threads, cap) in [(8, 64 << 20), (4, 1 << 20), (3, CDC_MAX as u64)] {
            let (par, par_snaps, par_tot) = run_corpus(threads, cap, packs);
            assert_eq!(seq.len(), par.len());
            for (i, (a, b)) in seq.iter().zip(&par).enumerate() {
                assert_eq!(
                    a, b,
                    "PutOutcome #{} (threads {}, cap {}, packs {:?})",
                    i, threads, cap, packs
                );
            }
            assert_eq!(
                seq_snaps, par_snaps,
                "manifests / object layout (threads {}, packs {:?})",
                threads, packs
            );
            assert_eq!(
                seq_tot, par_tot,
                "store totals (threads {}, packs {:?})",
                threads, packs
            );
        }
        // sanity: the duplicate-heavy corpus really deduplicated inside the file
        let dup = &seq[6];
        assert!(
            dup.dedup_chunks > 0 && dup.new_chunks > 0 && !dup.duplicate,
            "{:?}",
            dup
        );
    }
}

#[test]
fn inflight_bytes_are_bounded() {
    for cap in [CDC_MAX as u64, 1 << 20, 4 << 20] {
        let env = Env::new(4, cap, None);
        let s = env.open();
        let mut data = Vec::new();
        for i in 0..16u64 {
            data.extend_from_slice(&text(1 << 20, 100 + i));
            data.extend_from_slice(&random_bytes(512 << 10, 200 + i));
        }
        let o = s.put_bytes(&data, &opts()).unwrap();
        assert_eq!(s.read_to_vec(&o.file_id, None).unwrap(), data);
        let peak = stat(&s, &["ingest", "inflight_peak_bytes"]) as u64;
        println!("cap {} peak {}", cap, peak);
        assert!(peak > 0, "pipeline used");
        assert!(
            peak <= cap.max(CDC_MAX as u64),
            "peak {} exceeds cap {}",
            peak,
            cap
        );
        assert_eq!(
            stat(&s, &["inflight_bytes"]),
            0.0,
            "admission accounting released"
        );
        assert_consistent(&s);
    }
}

#[test]
fn concurrent_large_uploads_share_the_pool() {
    let env = Env::new(8, 2 << 20, None);
    let s = Arc::new(env.open());
    let shared = text(3 << 20, 999);
    let mut handles = Vec::new();
    for t in 0..8u64 {
        let s = s.clone();
        let shared = shared.clone();
        handles.push(std::thread::spawn(move || {
            let mut d = json_logs(4 << 20, t);
            d.extend_from_slice(&shared);
            d.extend_from_slice(&random_bytes(2 << 20, 50 + t));
            d.extend_from_slice(&shared);
            let o = s.put_bytes(&d, &opts()).unwrap();
            assert_eq!(o.file_id, sha256(&d));
            assert_eq!(o.size, d.len() as u64);
            assert_eq!(o.new_chunks + o.dedup_chunks, o.chunks);
            (o, d)
        }));
    }
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    for (o, d) in &results {
        assert_eq!(&s.read_to_vec(&o.file_id, None).unwrap(), d);
    }
    // inside each upload the second copy of `shared` is pure dedup; across racing uploads a chunk
    // may be staged by several writers (the index keeps one), exactly as with sequential ingest
    let new_total: u64 = results.iter().map(|r| r.0.new_chunks).sum();
    let unique: std::collections::HashSet<_> = results
        .iter()
        .flat_map(|r| {
            s.get_manifest(&r.0.file_id)
                .unwrap()
                .unwrap()
                .chunks
                .into_iter()
                .map(|c| c.id)
        })
        .collect();
    assert!(new_total >= unique.len() as u64);
    assert_eq!(
        stat(&s, &["chunks"]),
        unique.len() as f64,
        "each chunk indexed once"
    );
    for (o, _) in &results {
        assert!(o.dedup_chunks > 0, "{:?}", o);
    }
    assert_eq!(stat(&s, &["inflight_bytes"]), 0.0);
    let pool = stat(&s, &["ingest", "pool_threads"]);
    assert!(pool >= 1.0);
    assert_consistent(&s);
}

#[test]
fn admission_failure_mid_upload_stops_the_pipeline() {
    // capacity runs out while chunks are in flight: same error as sequential, nothing leaks
    for threads in [1, 6] {
        let mut env = Env::new(threads, 1 << 20, None);
        env.cfg.max_bytes = Some(3 << 20);
        let s = env.open();
        let data = random_bytes(12 << 20, 9);
        let err = s.put_bytes(&data, &opts()).unwrap_err();
        assert!(
            matches!(err, StoreError::Full { .. }),
            "threads {}: {}",
            threads,
            err
        );
        assert_eq!(stat(&s, &["inflight_bytes"]), 0.0, "threads {}", threads);
        assert!(s.file_meta(&sha256(&data)).unwrap().is_none());
        assert_consistent(&s);
        let small = text(1 << 20, 4);
        let o = s.put_bytes(&small, &opts()).unwrap();
        assert_eq!(s.read_to_vec(&o.file_id, None).unwrap(), small);
        assert_consistent(&s);
    }
}

fn crash_at(s: &Store, point: &'static str) {
    s.set_fail_hook(Some(Arc::new(move |p: &str| p == point)));
}

#[test]
fn crash_injection_with_parallel_ingest() {
    // (point, pack threshold, data): file-layout points need objects in their own files; the
    // early pack flush (â‰¥ 16 MiB of small objects) fires mid-upload while jobs are in flight
    let cases: Vec<(&'static str, Option<usize>, Vec<u8>)> = vec![
        ("write.before_rename", Some(0), text(6 << 20, 2)),
        ("write.before_commit", Some(0), text(6 << 20, 3)),
        ("write.after_commit", Some(0), text(6 << 20, 4)),
        ("pack.after_append", None, random_bytes(40 << 20, 5)),
        ("pack.before_commit", None, text(6 << 20, 6)),
    ];
    for (point, packs, data) in cases {
        let env = Env::new(6, 1 << 20, packs);
        let s = env.open();
        let keep = json_logs(1 << 20, 1);
        let kid = s.put_bytes(&keep, &opts()).unwrap().file_id;
        let mut data = data;
        data.extend_from_slice(&keep[..300_000]);
        crash_at(&s, point);
        let err = s.put_bytes(&data, &opts()).unwrap_err();
        assert!(
            matches!(err, StoreError::Injected(p) if p == point),
            "{}: {}",
            point,
            err
        );
        drop(s);
        let s = env.open();
        assert_consistent(&s);
        let fid = sha256(&data);
        let committed = point == "write.after_commit";
        assert_eq!(s.file_meta(&fid).unwrap().is_some(), committed, "{}", point);
        if !committed {
            let o = s.put_bytes(&data, &opts()).unwrap();
            assert_eq!(o.file_id, fid);
        }
        assert_eq!(s.read_to_vec(&fid, None).unwrap(), data, "{}", point);
        assert_eq!(s.read_to_vec(&kid, None).unwrap(), keep, "no data loss");
        assert_consistent(&s);
    }
}

// ---- multithreaded zstd ------------------------------------------------------------------------

fn no_dict(_: &DictId) -> Option<Arc<Vec<u8>>> {
    None
}

/// The TS decoder's rule: the zstd payload is exactly one frame (no trailing bytes) and the frame
/// header carries the content size.
fn assert_single_frame(blob: &[u8], len: usize) {
    let payload = &blob[HEADER_LEN..];
    let frame = zstd::zstd_safe::find_frame_compressed_size(payload).expect("valid frame");
    assert_eq!(frame, payload.len(), "exactly one zstd frame");
    assert_eq!(
        zstd::zstd_safe::get_frame_content_size(payload)
            .ok()
            .flatten(),
        Some(len as u64)
    );
}

#[test]
fn mt_zstd_emits_one_standard_frame() {
    let data = text(24 << 20, 77);
    let base = EncodeParams {
        codec: Codec::Zstd,
        level: 3,
        window_log: None,
        filter: Filter::None,
        stride: 0,
        dict: None,
    };
    let st = codec::encode(&base, &data).unwrap();
    let mt = codec::encode_with_workers(&base, &data, 4).unwrap();
    assert_ne!(st, mt, "multithreaded encoder engaged (zstdmt feature)");
    assert_eq!(&st[..HEADER_LEN], &mt[..HEADER_LEN], "identical v2 header");
    for b in [&st, &mt] {
        assert_single_frame(b, data.len());
        assert_eq!(codec::decode_v2(b, usize::MAX, &no_dict).unwrap(), data);
        assert_eq!(codec::decode_any(b, usize::MAX, &no_dict).unwrap(), data);
    }
    // the plain zstd library decoder accepts it too
    assert_eq!(zstd::stream::decode_all(&mt[HEADER_LEN..]).unwrap(), data);

    // with window log, filter and a dictionary
    let floats = f32_sensor(4 << 20, 3);
    let dict_bytes = small_json(5).repeat(64);
    let dict_id = codec::sha256(&dict_bytes);
    let lookup = |id: &DictId| {
        if *id == dict_id {
            Some(Arc::new(dict_bytes.clone()))
        } else {
            None
        }
    };
    for (p, d) in [
        (
            EncodeParams {
                window_log: Some(24),
                filter: Filter::Shuffle,
                stride: 4,
                ..base
            },
            &floats,
        ),
        (
            EncodeParams {
                level: 9,
                dict: Some((&dict_id, &dict_bytes)),
                ..base
            },
            &data,
        ),
    ] {
        let mt = codec::encode_with_workers(&p, d, 3).unwrap();
        assert_single_frame(&mt, d.len());
        assert_eq!(&codec::decode_v2(&mt, usize::MAX, &lookup).unwrap(), d);
    }
    // non-zstd codecs ignore the worker count
    let b = EncodeParams {
        codec: Codec::Brotli,
        level: 1,
        ..base
    };
    assert_eq!(
        codec::encode_with_workers(&b, &data[..1 << 20], 4).unwrap(),
        codec::encode(&b, &data[..1 << 20]).unwrap()
    );
}

#[test]
fn engine_uses_mt_only_for_large_zstd_bodies() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = test_config(dir.path(), 3);
    c.persist = false;
    c.mt_threshold = 1 << 20;
    c.mt_workers = 4;
    let e = Engine::new(c);
    let z = Recipe::new(Codec::Zstd, 3);
    assert_eq!(
        e.mt_workers_for(&z, 1 << 20),
        0,
        "at the threshold: single-threaded"
    );
    assert_eq!(e.mt_workers_for(&z, (1 << 20) + 1), 4);
    assert_eq!(
        e.mt_workers_for(&Recipe::new(Codec::Brotli, 5), 64 << 20),
        0
    );
    assert_eq!(e.mt_workers_for(&Recipe::new(Codec::Lz4, 0), 64 << 20), 0);

    let data = text(12 << 20, 8);
    let out = e.compress(&data, Some("text/plain"), false);
    let r = out.recipe.expect("v2 blob");
    assert_eq!(r.codec, Codec::Zstd, "baseline champion");
    assert_single_frame(&out.blob, data.len());
    assert_eq!(
        codec::decode_any(&out.blob, usize::MAX, &no_dict).unwrap(),
        data
    );

    // REACTOR_OVERLAP_VERIFY: same guarantee and format, verify runs alongside the encode
    let mut c = test_config(dir.path(), 3);
    c.persist = false;
    c.mt_threshold = 1 << 20;
    c.mt_workers = 4;
    c.overlap_verify = true;
    let e = Engine::new(c);
    let out = e.compress(&data, Some("text/plain"), false);
    assert_eq!(
        out.recipe.expect("v2 blob").codec,
        Codec::Zstd,
        "{:?}",
        out.note
    );
    assert_single_frame(&out.blob, data.len());
    assert_eq!(
        codec::decode_any(&out.blob, usize::MAX, &no_dict).unwrap(),
        data
    );
}
