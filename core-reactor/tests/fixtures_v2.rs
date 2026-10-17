//! Cross-language v2 fixtures in `tests/fixtures/v2/` (decoded by the TypeScript tests).
//! Regenerate with `REACTOR_WRITE_FIXTURES=1 cargo test --test fixtures_v2`.

mod common;

use common::*;
use core_reactor::codec::{self, decode_v2, Codec, DictId, Filter};
use core_reactor::recipe::Recipe;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/v2")
}

fn cases() -> Vec<(&'static str, Recipe, Vec<u8>)> {
    let f32s = f32_sensor(3_000, 1);
    let f64s: Vec<u8> = (0..1500).flat_map(|i| (1000.0 + (i as f64) * 0.25).to_le_bytes()).collect();
    let mut tail = f32_sensor(250, 2);
    tail.extend_from_slice(&[0xAA, 0xBB, 0xCC]); // 1003 bytes: shuffle tail
    vec![
        ("raw_text", Recipe::new(Codec::Raw, 0), text(3_000, 1)),
        ("raw_delta2_tiny", Recipe::new(Codec::Raw, 0).with_filter(Filter::Delta, 2), vec![10, 20, 5, 1, 7]),
        ("lz4_text", Recipe::new(Codec::Lz4, 0), text(40_000, 2)),
        ("lz4_delta4_f32", Recipe::new(Codec::Lz4, 0).with_filter(Filter::Delta, 4), f32s.clone()),
        ("lz4_empty", Recipe::new(Codec::Lz4, 0), vec![]),
        ("lz4_one_byte", Recipe::new(Codec::Lz4, 0), vec![0x7F]),
        ("deflate6_json", Recipe::new(Codec::Deflate, 6), json_logs(30_000, 3)),
        ("deflate9_shuffle8_f64", Recipe::new(Codec::Deflate, 9).with_filter(Filter::Shuffle, 8), f64s),
        ("deflate0_text", Recipe::new(Codec::Deflate, 0), text(5_000, 4)),
        ("zstd3_json", Recipe::new(Codec::Zstd, 3), json_logs(50_000, 5)),
        ("zstd19_w20_json", Recipe::new(Codec::Zstd, 19).with_window(Some(20)), json_logs(50_000, 6)),
        ("zstd9_shuffle4_f32", Recipe::new(Codec::Zstd, 9).with_filter(Filter::Shuffle, 4), f32s.clone()),
        ("zstd9_delta4_f32", Recipe::new(Codec::Zstd, 9).with_filter(Filter::Delta, 4), f32s.clone()),
        ("zstd3_shuffle8_tail", Recipe::new(Codec::Zstd, 3).with_filter(Filter::Shuffle, 8), tail.clone()),
        ("zstd1_delta8_short", Recipe::new(Codec::Zstd, 1).with_filter(Filter::Delta, 8), vec![1, 2, 3, 4, 5]),
        ("zstd3_empty", Recipe::new(Codec::Zstd, 3), vec![]),
        ("zstd3_random", Recipe::new(Codec::Zstd, 3), random_bytes(2_000, 7)),
        ("brotli5_text", Recipe::new(Codec::Brotli, 5), text(40_000, 8)),
        ("brotli11_w18_json", Recipe::new(Codec::Brotli, 11).with_window(Some(18)), json_logs(20_000, 9)),
        ("brotli9_delta1_text", Recipe::new(Codec::Brotli, 9).with_filter(Filter::Delta, 1), text(10_000, 10)),
        ("brotli0_shuffle2_tail", Recipe::new(Codec::Brotli, 0).with_filter(Filter::Shuffle, 2), tail),
        ("brotli5_empty", Recipe::new(Codec::Brotli, 5), vec![]),
    ]
}

/// Procedural codec (codec 5, NETWORK_SPEC §1) fixtures; written after the dictionary fixtures so
/// MANIFEST.json keeps the earlier entries as a prefix.
fn proc_cases() -> Vec<(&'static str, Recipe, Vec<u8>)> {
    vec![
        ("procedural3_mixed", Recipe::new(Codec::Procedural, 3), proc_mixed()),
        ("procedural19_arith_widths", Recipe::new(Codec::Procedural, 19), proc_arith_widths()),
        ("procedural1_delta4_counter", Recipe::new(Codec::Procedural, 1).with_filter(Filter::Delta, 4), arith(4, false, 5_000, 1000, 7)),
        ("procedural3_shuffle8_mixed", Recipe::new(Codec::Procedural, 3).with_filter(Filter::Shuffle, 8), proc_mixed()),
        ("procedural5_periodic_text", Recipe::new(Codec::Procedural, 5), periodic(&text(500, 11), 50_000)),
        ("procedural3_fill_only", Recipe::new(Codec::Procedural, 3), vec![0x5A; 100_000]),
        ("procedural3_random", Recipe::new(Codec::Procedural, 3), random_bytes(3_000, 12)),
        ("procedural3_empty", Recipe::new(Codec::Procedural, 3), vec![]),
        ("procedural3_one_byte", Recipe::new(Codec::Procedural, 3), vec![0x7F]),
    ]
}

/// `k` elements of `w` bytes: `start + i·delta` (wrapping), little- or big-endian.
fn arith(w: usize, be: bool, k: usize, start: u64, delta: u64) -> Vec<u8> {
    let mask = if w == 8 { u64::MAX } else { (1u64 << (8 * w)) - 1 };
    let mut out = Vec::with_capacity(k * w);
    for i in 0..k as u64 {
        let v = start.wrapping_add(i.wrapping_mul(delta)) & mask;
        let le = &v.to_le_bytes()[..w];
        if be {
            out.extend(le.iter().rev());
        } else {
            out.extend_from_slice(le);
        }
    }
    out
}

fn periodic(pattern: &[u8], len: usize) -> Vec<u8> {
    pattern.iter().copied().cycle().take(len).collect()
}

fn proc_arith_widths() -> Vec<u8> {
    let mut d = Vec::new();
    for (w, be) in [(1, false), (2, false), (2, true), (4, false), (4, true), (8, false), (8, true)] {
        let mask = if w == 8 { u64::MAX } else { (1u64 << (8 * w)) - 1 };
        d.extend(arith(w, be, 100, mask - 3, mask - 0x10)); // wrapping start and "negative" delta
        d.push(0x99);
    }
    d
}

fn proc_mixed() -> Vec<u8> {
    let mut d = text(2_000, 21);
    d.extend(vec![0u8; 3_000]);
    d.extend(arith(4, false, 2_000, 7, 3));
    d.extend(periodic(&random_bytes(300, 22), 6_000));
    d.extend(random_bytes(500, 23));
    d.extend(arith(8, true, 200, u64::MAX - 5, 0x0123_4567_89ab_cdef));
    d.extend(arith(2, true, 1_000, 0xFFF0, 0x0101));
    d.extend(periodic(b"abc", 999));
    d
}

#[test]
fn write_v2_fixtures() {
    if std::env::var("REACTOR_WRITE_FIXTURES").is_err() {
        return;
    }
    let d = dir();
    std::fs::create_dir_all(d.join("dicts")).unwrap();
    let mut entries = Vec::new();
    let mut write = |name: &str, recipe: &Recipe, data: &[u8], blob: Vec<u8>, dict: Option<String>| {
        std::fs::write(d.join(format!("{}.v2.bin", name)), &blob).unwrap();
        std::fs::write(d.join(format!("{}.input.bin", name)), data).unwrap();
        entries.push(json!({
            "name": name,
            "blob": format!("{}.v2.bin", name),
            "original": format!("{}.input.bin", name),
            "recipe": recipe,
            "dict": dict,
        }));
    };
    for (name, recipe, data) in cases() {
        let blob = recipe.encode(&data, None).unwrap();
        write(name, &recipe, &data, blob, None);
    }
    let samples: Vec<Vec<u8>> = (0..64).map(small_json).collect();
    let dict = zstd::dict::from_samples(&samples, 8 * 1024).unwrap();
    let id = codec::sha256(&dict);
    let dict_rel = format!("dicts/{}.dict", hex::encode(id));
    std::fs::write(d.join(&dict_rel), &dict).unwrap();
    for (name, recipe, data) in [
        ("zstd3_dict_json", Recipe::new(Codec::Zstd, 3).with_dict(Some(&id)), small_json(4242)),
        ("zstd19_dict_shuffle1_json", Recipe::new(Codec::Zstd, 19).with_filter(Filter::Shuffle, 1).with_dict(Some(&id)), small_json(4343)),
    ] {
        let blob = recipe.encode(&data, Some(&dict)).unwrap();
        write(name, &recipe, &data, blob, Some(dict_rel.clone()));
    }
    for (name, recipe, data) in proc_cases() {
        let blob = recipe.encode(&data, None).unwrap();
        write(name, &recipe, &data, blob, None);
    }
    let manifest = json!({
        "format": "datran blob v2 (core-reactor/docs/EVOLUTION_SPEC.md)",
        "generator": "core-reactor tests/fixtures_v2.rs",
        "fixtures": entries,
    });
    std::fs::write(d.join("MANIFEST.json"), serde_json::to_string_pretty(&manifest).unwrap() + "\n").unwrap();
}

#[test]
fn v2_fixtures_decode_and_match_manifest() {
    let d = dir();
    let manifest: Value = serde_json::from_slice(&std::fs::read(d.join("MANIFEST.json")).expect("MANIFEST.json")).unwrap();
    let list = manifest["fixtures"].as_array().unwrap();
    assert!(list.len() >= cases().len() + 2 + proc_cases().len());
    assert!(list.iter().filter(|e| e["recipe"]["codec"] == "procedural").count() >= proc_cases().len());
    let mut with_dict = 0;
    for e in list {
        let name = e["name"].as_str().unwrap();
        let blob = std::fs::read(d.join(e["blob"].as_str().unwrap())).unwrap();
        let original = std::fs::read(d.join(e["original"].as_str().unwrap())).unwrap();
        let recipe = Recipe::from_json_value(&e["recipe"]).unwrap_or_else(|| panic!("{} recipe", name));
        let dict = e["dict"].as_str().map(|p| Arc::new(std::fs::read(d.join(p)).unwrap()));
        if let Some(dict) = &dict {
            with_dict += 1;
            assert_eq!(Some(codec::sha256(dict)), recipe.dict_id());
        }
        // header agrees with the recipe
        assert_eq!(blob[2], recipe.codec.id(), "{}", name);
        assert_eq!(blob[3], recipe.filter.id(), "{}", name);
        assert_eq!(blob[4], recipe.stride, "{}", name);
        let lookup = |_: &DictId| dict.clone();
        assert_eq!(decode_v2(&blob, 64 << 20, &lookup).unwrap(), original, "{}", name);
        // re-encoding with this build is byte-identical (deterministic encoders)
        assert_eq!(recipe.encode(&original, dict.as_deref().map(|v| v.as_slice())).unwrap(), blob, "{}", name);
    }
    assert!(with_dict >= 1);
}
