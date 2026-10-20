//! Object-store bench:
//! `cargo run --release --bin store-bench -- <folder> [--copies N] [--keep DIR] [--concurrency N]`
//!
//! Ingests every file of a folder (recursively, streamed from disk) into a fresh store, then
//! prints logical / unique / physical bytes, dedup and compression ratios, ingest throughput,
//! one fusion pass (structural + access signals, measured gains), and cold read throughput with
//! every byte verified against the file id. `--copies N` ingests the folder N times with a small
//! per-copy prefix so cross-file dedup is exercised on real data.
//!
//! Single-large-upload mode (multi-core compression, `REACTOR_COMPRESS_THREADS`):
//! `store-bench --gen-mib N` ingests N MiB of generated mixed text / JSON / binary / float data
//! (generated in memory first, not timed) as ONE upload; `store-bench <folder> --concat` streams
//! the whole folder as one upload. Both print ingest MiB/s and verified read-back MiB/s and skip
//! the fusion phase. `--encrypt` enables encryption at rest with a random key (or set
//! `REACTOR_MASTER_KEY`) to measure its overhead.

use core_reactor::evolution::{Engine, EvoConfig};
use core_reactor::store::{PutOptions, Store, StoreConfig};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const MAX_FILES: usize = 20_000;

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if p.is_dir() {
            if !matches!(name.as_str(), ".git" | "target" | "node_modules" | ".next") {
                collect(&p, out);
            }
        } else if p.is_file() {
            out.push(p);
        }
    }
}

fn mib(b: f64) -> f64 {
    b / (1024.0 * 1024.0)
}

/// Deterministic mixed corpus: text, JSON logs, little-endian floats and random bytes in
/// 4–260 KiB segments (no long-range repeats, so dedup does not short-cut compression).
fn generate(n: usize) -> Vec<u8> {
    let mut s: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move || {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        s
    };
    let words: [&[u8]; 16] = [
        b"the",
        b"reactor",
        b"chunk",
        b"stream",
        b"of",
        b"and",
        b"datran",
        b"pack",
        b"index",
        b"commit",
        b"verify",
        b"object",
        b"to",
        b"a",
        b"compress",
        b"store",
    ];
    let mut out = Vec::with_capacity(n + 300_000);
    let mut line = 0u64;
    while out.len() < n {
        let seg = 4096 + (next() % (256 * 1024)) as usize;
        let end = out.len() + seg;
        match next() % 4 {
            0 => {
                while out.len() < end {
                    let r = next();
                    out.extend_from_slice(words[(r % 16) as usize]);
                    out.push(if r.is_multiple_of(11) { b'\n' } else { b' ' });
                }
            }
            1 => {
                while out.len() < end {
                    let r = next();
                    line += 1;
                    out.extend_from_slice(
                        format!(
                            "{{\"ts\":{},\"level\":\"{}\",\"user\":\"u{}\",\"bytes\":{},\"msg\":\"{}\"}}\n",
                            1_700_000_000_000u64 + line * 17,
                            ["INFO", "WARN", "DEBUG", "ERROR"][(r % 4) as usize],
                            (r >> 8) % 5000,
                            (r >> 20) % 1_000_000,
                            ["upload complete", "chunk stored", "cache miss"][((r >> 40) % 3) as usize]
                        )
                        .as_bytes(),
                    );
                }
            }
            2 => {
                let mut v = (next() % 1000) as f32;
                while out.len() < end {
                    v += ((next() % 21) as f32 - 10.0) * 0.01;
                    out.extend_from_slice(&((v * 100.0).round() / 100.0).to_le_bytes());
                }
            }
            _ => {
                while out.len() < end {
                    out.extend_from_slice(&next().to_le_bytes());
                }
            }
        }
    }
    out.truncate(n);
    out
}

/// Reads the files one after another as one stream.
struct Concat {
    paths: std::vec::IntoIter<PathBuf>,
    cur: Option<std::io::BufReader<std::fs::File>>,
}

impl Read for Concat {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if let Some(r) = self.cur.as_mut() {
                let n = r.read(buf)?;
                if n > 0 || buf.is_empty() {
                    return Ok(n);
                }
                self.cur = None;
            }
            match self.paths.next() {
                Some(p) => {
                    self.cur = std::fs::File::open(p)
                        .ok()
                        .map(|f| std::io::BufReader::with_capacity(256 * 1024, f))
                }
                None => return Ok(0),
            }
        }
    }
}

fn single_upload(store: &Store, reader: impl Read, label: &str) {
    let t = Instant::now();
    let o = store
        .put_reader(
            reader,
            &PutOptions {
                content_type: None,
                sample: true,
            },
        )
        .expect("put");
    let s = t.elapsed().as_secs_f64();
    let st = store.stats().unwrap();
    println!(
        "single upload ({}): {:.3} MiB in {:.3} s = {:.2} MiB/s | compress_threads {} pool_threads {} cores {} | chunks {} new {} dedup {} | stored {:.2} MiB ({:.3}x) | inflight peak {:.1} MiB",
        label,
        mib(o.size as f64),
        s,
        mib(o.size as f64) / s.max(1e-9),
        st["ingest"]["compress_threads"],
        st["ingest"]["pool_threads"],
        std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        o.chunks,
        o.new_chunks,
        o.dedup_chunks,
        mib(o.stored_bytes as f64),
        o.new_bytes as f64 / (o.stored_bytes.max(1)) as f64,
        mib(st["ingest"]["inflight_peak_bytes"].as_f64().unwrap_or(0.0))
    );
    println!("file_id {}", hex::encode(o.file_id));
    let t = Instant::now();
    let mut h = Sha256::new();
    store
        .read_range(&o.file_id, 0, o.size, &mut |b| {
            h.update(b);
            true
        })
        .expect("read");
    let got: [u8; 32] = h.finalize().into();
    assert_eq!(got, o.file_id, "read-back mismatch");
    let s = t.elapsed().as_secs_f64();
    println!(
        "read back (verified): {:.3} s = {:.2} MiB/s",
        s,
        mib(o.size as f64) / s.max(1e-9)
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (mut folder, mut copies, mut keep, mut concurrency) = (None, 1usize, None, 1usize);
    let (mut gen_mib, mut concat, mut encrypt) = (None::<usize>, false, false);
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--gen-mib" => {
                gen_mib = args.get(i + 1).and_then(|v| v.parse().ok());
                i += 1;
            }
            "--concat" => concat = true,
            "--encrypt" => encrypt = true,
            "--concurrency" | "-j" => {
                concurrency = args
                    .get(i + 1)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1)
                    .clamp(1, 256);
                i += 1;
            }
            "--copies" => {
                copies = args
                    .get(i + 1)
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(1)
                    .max(1);
                i += 1;
            }
            "--keep" => {
                keep = args.get(i + 1).map(PathBuf::from);
                i += 1;
            }
            other => folder = Some(PathBuf::from(other)),
        }
        i += 1;
    }
    let root = keep.unwrap_or_else(|| {
        std::env::temp_dir().join(format!("core-reactor-store-bench-{}", std::process::id()))
    });
    let _ = std::fs::remove_dir_all(&root);
    let profile = std::env::var("REACTOR_PROFILE")
        .ok()
        .and_then(|v| core_reactor::evolution::Profile::parse(&v))
        .unwrap_or_default();
    let mut ec = EvoConfig::new(root.join("evo")).with_profile(profile);
    ec.persist = false;
    println!(
        "profile: {} (default recipe {})",
        profile.name(),
        profile.default_recipe().label()
    );
    // encryption at rest: REACTOR_MASTER_KEY* from the environment, or `--encrypt` (random key)
    let mut keys = core_reactor::crypto::KeyRing::from_env().expect("key configuration");
    if encrypt && !keys.enabled() {
        let mut k = [0u8; 32];
        rand::RngCore::fill_bytes(&mut rand::rngs::OsRng, &mut k);
        keys = core_reactor::crypto::KeyRing::single("bench", k);
    }
    println!(
        "encryption at rest: {}",
        keys.active_id()
            .map(|k| format!("on (key {:?}, {})", k, core_reactor::crypto::ALGORITHM))
            .unwrap_or_else(|| "off".into())
    );
    ec.keys = Arc::new(keys);
    let engine = Arc::new(Engine::new(ec));
    let mut cfg = StoreConfig::from_env(&root);
    cfg.coaccess_min = 3.0;
    let store = Store::open(cfg, engine).expect("open store");

    if let Some(n) = gen_mib {
        let data = generate(n << 20);
        single_upload(&store, data.as_slice(), &format!("generated {} MiB", n));
        drop(store);
        let _ = std::fs::remove_dir_all(&root);
        return;
    }
    let Some(folder) = folder else {
        eprintln!("usage: store-bench <folder> [--copies N] [--keep DIR] [--concurrency N] [--concat] | --gen-mib N");
        std::process::exit(2);
    };
    let mut paths = Vec::new();
    collect(&folder, &mut paths);
    if concat {
        let n = paths.len();
        let reader = Concat {
            paths: paths.into_iter(),
            cur: None,
        };
        single_upload(
            &store,
            reader,
            &format!("{} ({} files concatenated)", folder.display(), n),
        );
        drop(store);
        let _ = std::fs::remove_dir_all(&root);
        return;
    }

    // ingest (streamed from disk; `--concurrency N` puts N files at a time, like concurrent
    // HTTP uploads, so the store's group commit can batch their fsyncs and index commits)
    let t = Instant::now();
    let jobs: Vec<(usize, &PathBuf)> = (0..copies)
        .flat_map(|c| paths.iter().map(move |p| (c, p)))
        .collect();
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<(core_reactor::store::Id, u64, u64, u64)>> = Mutex::new(Vec::new());
    std::thread::scope(|s| {
        for _ in 0..concurrency {
            s.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some((copy, p)) = jobs.get(i) else { break };
                let Ok(f) = std::fs::File::open(p) else {
                    continue;
                };
                let prefix = if *copy == 0 {
                    Vec::new()
                } else {
                    format!("copy {}\n", copy).into_bytes()
                };
                let reader = std::io::Cursor::new(prefix)
                    .chain(std::io::BufReader::with_capacity(256 * 1024, f));
                match store.put_reader(
                    reader,
                    &PutOptions {
                        content_type: None,
                        sample: true,
                    },
                ) {
                    Ok(o) => results.lock().unwrap().push((
                        o.file_id,
                        o.size,
                        o.new_chunks,
                        o.dedup_chunks,
                    )),
                    Err(e) => eprintln!("skip {}: {}", p.display(), e),
                }
            });
        }
    });
    let ingest_s = t.elapsed().as_secs_f64();
    let results = results.into_inner().unwrap();
    let logical: u64 = results.iter().map(|r| r.1).sum();
    let new_chunks: u64 = results.iter().map(|r| r.2).sum();
    let dedup_chunks: u64 = results.iter().map(|r| r.3).sum();
    let ids: Vec<(core_reactor::store::Id, u64)> = results.iter().map(|r| (r.0, r.1)).collect();
    let s0 = store.stats().unwrap();
    println!("group commit: {}", s0["group_commit"]);
    println!("packs: {}", s0["packs"]);
    let g = |v: &serde_json::Value, k: &str| v[k].as_f64().unwrap_or(0.0);
    println!(
        "corpus: {} ({} files x {} copies, {:.3} MiB logical)",
        folder.display(),
        paths.len(),
        copies,
        mib(logical as f64)
    );
    println!(
        "ingest: {:.3} s, {:.2} MiB/s, {:.0} files/s (concurrency {}) | chunks new {} dedup {}",
        ingest_s,
        mib(logical as f64) / ingest_s.max(1e-9),
        ids.len() as f64 / ingest_s.max(1e-9),
        concurrency,
        new_chunks,
        dedup_chunks
    );
    println!(
        "bytes: logical {:.2} MiB, unique {:.2} MiB, physical {:.2} MiB | dedup {:.3}x, compression {:.3}x, total {:.3}x | {} objects",
        mib(g(&s0, "logical_bytes")),
        mib(g(&s0, "unique_bytes")),
        mib(g(&s0, "live_physical_bytes")),
        g(&s0, "dedup_ratio"),
        g(&s0, "compression_ratio"),
        g(&s0, "total_ratio"),
        g(&s0, "objects")
    );

    // cold read, verified
    let read_all = |label: &str| {
        let t = Instant::now();
        let (mut bytes, mut objects, mut chunks) = (0u64, 0u64, 0u64);
        for (id, size) in &ids {
            let mut h = Sha256::new();
            let st = store
                .read_range(id, 0, *size, &mut |b| {
                    h.update(b);
                    true
                })
                .expect("read");
            let got: [u8; 32] = h.finalize().into();
            assert_eq!(&got, id, "read-back mismatch");
            bytes += st.bytes;
            objects += st.objects_decoded;
            chunks += st.chunks;
        }
        let s = t.elapsed().as_secs_f64();
        println!(
            "read ({}): {:.2} s, {:.1} MiB/s, {} chunks from {} object decodes (all SHA-256 verified)",
            label,
            s,
            mib(bytes as f64) / s.max(1e-9),
            chunks,
            objects
        );
    };
    read_all("before fusion");

    // fusion (structural signal from shared runs; access signal from the reads above)
    for _ in 0..2 {
        read_all("warming access signal");
    }
    let t = Instant::now();
    let rep = store.run_fusion_pass().expect("fusion");
    let accepted: Vec<_> = rep.evaluated.iter().filter(|e| e.3).collect();
    let (cur, fused): (u64, u64) = accepted.iter().fold((0, 0), |a, e| (a.0 + e.1, a.1 + e.2));
    println!(
        "fusion: {:.2} s | structural pairs {} | candidates {} fused {} rejected {} skipped {} | accepted runs {:.2} MiB -> {:.2} MiB (saved {:.2} MiB, {:.1}%)",
        t.elapsed().as_secs_f64(),
        rep.structural_pairs,
        rep.candidates,
        rep.fused,
        rep.rejected,
        rep.skipped,
        mib(cur as f64),
        mib(fused as f64),
        mib(rep.bytes_saved as f64),
        if cur > 0 { 100.0 * rep.bytes_saved as f64 / cur as f64 } else { 0.0 }
    );
    read_all("after fusion");
    store.flush_access().unwrap();
    let s1 = store.stats().unwrap();
    println!(
        "after fusion: physical {:.2} MiB, super-chunks {}, reads saved {}, total {:.3}x",
        mib(g(&s1, "live_physical_bytes")),
        g(&s1, "super_chunks"),
        s1["fusion"]["reads_saved"],
        g(&s1, "total_ratio")
    );
    let v = store.verify_index(false).expect("verify");
    println!(
        "index check: {}",
        if v.ok() {
            "consistent".to_string()
        } else {
            format!("{:?}", v.problems)
        }
    );
    drop(store);
    let _ = std::fs::remove_dir_all(&root);
}
