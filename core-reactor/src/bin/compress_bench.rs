//! Large-blob `/compress` bench: `cargo run --release --bin compress-bench -- [MIB] [WORKERS]`
//!
//! Generates MIB (default 256) MiB of text and times `Engine::compress` (the exact `/compress`
//! path minus HTTP: classify → champion zstd-3 → encode → verify round-trip) single-threaded
//! and with zstd multithreading (`WORKERS`, default every core), plus the bare zstd-3 / zstd-9
//! encode. Every MT blob is checked to be one zstd frame and to decode with the normal decoder.

use core_reactor::codec::{self, DictId, HEADER_LEN};
use core_reactor::evolution::{Engine, EvoConfig};
use core_reactor::recipe::Recipe;
use std::sync::Arc;
use std::time::Instant;

fn text(n: usize) -> Vec<u8> {
    let words: [&[u8]; 16] = [
        b"the", b"reactor", b"chunk", b"stream", b"of", b"and", b"datran", b"pack", b"index", b"commit", b"verify",
        b"object", b"to", b"a", b"compress", b"store",
    ];
    let mut s: u64 = 0x2545_f491_4f6c_dd1d;
    let mut out = Vec::with_capacity(n + 16);
    while out.len() < n {
        s ^= s << 13;
        s ^= s >> 7;
        s ^= s << 17;
        out.extend_from_slice(words[(s % 16) as usize]);
        out.push(if s.is_multiple_of(11) { b'\n' } else { b' ' });
        if s.is_multiple_of(97) {
            out.extend_from_slice(format!("{} ", s % 100_000).as_bytes());
        }
    }
    out.truncate(n);
    out
}

fn no_dict(_: &DictId) -> Option<Arc<Vec<u8>>> {
    None
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let n_mib: usize = args.first().and_then(|v| v.parse().ok()).unwrap_or(256);
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let workers: u32 = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(cores as u32);
    let data = text(n_mib << 20);
    let mib = data.len() as f64 / (1024.0 * 1024.0);
    println!("{} MiB text, {} logical cores, MT workers {}", n_mib, cores, workers);

    let engine = |w: u32| {
        let mut c = EvoConfig::new(std::env::temp_dir().join("core-reactor-compress-bench"));
        c.persist = false;
        c.mt_workers = w;
        c.max_output = usize::MAX;
        Engine::new(c)
    };
    for (label, w) in [("single-threaded", 1u32), ("zstd MT", workers)] {
        let e = engine(w);
        let t = Instant::now();
        let out = e.compress(&data, Some("text/plain"), false);
        let s = t.elapsed().as_secs_f64();
        let r = out.recipe.as_ref().map(|r| r.label()).unwrap_or_else(|| "raw".into());
        let payload = &out.blob[HEADER_LEN..];
        let frames_ok = zstd::zstd_safe::find_frame_compressed_size(payload).ok() == Some(payload.len());
        assert_eq!(codec::decode_any(&out.blob, usize::MAX, &no_dict).unwrap(), data);
        println!(
            "Engine::compress {:<16} {:>8.3} s {:>9.1} MiB/s  ratio {:.3}x  recipe {}  single frame {}",
            label,
            s,
            mib / s,
            data.len() as f64 / out.blob.len() as f64,
            r,
            frames_ok
        );
    }
    for level in [3, 9] {
        let recipe = Recipe::new(codec::Codec::Zstd, level);
        let mut line = format!("bare zstd-{} encode:", level);
        let mut base = 0.0;
        for w in [0u32, workers] {
            let t = Instant::now();
            let b = recipe.encode_with_workers(&data, None, w).unwrap();
            let s = t.elapsed().as_secs_f64();
            if w == 0 {
                base = s;
            } else {
                let payload = &b[HEADER_LEN..];
                assert_eq!(zstd::zstd_safe::find_frame_compressed_size(payload).ok(), Some(payload.len()));
                assert_eq!(codec::decode_v2(&b, usize::MAX, &no_dict).unwrap(), data);
            }
            line.push_str(&format!(
                "  {} {:.3} s {:.1} MiB/s ratio {:.3}x{}",
                if w == 0 { "ST".to_string() } else { format!("MT{}", w) },
                s,
                mib / s,
                data.len() as f64 / b.len() as f64,
                if w == 0 { String::new() } else { format!(" (speedup {:.2}x)", base / s) }
            ));
        }
        println!("{}", line);
    }
}
