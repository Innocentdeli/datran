//! Procedural codec (blob v2 codec 5, NETWORK_SPEC §1): round-trips, encoder thresholds, every
//! decoder rejection rule, fuzzing, the >32,000x case, random-data overhead and evolution.

mod common;

use common::*;
use core_reactor::classify::TEXT_JSON;
use core_reactor::codec::{self, crc32, decode_any, decode_v2, Codec, DecodeError, DictId, Filter, HEADER_LEN, STRIDES};
use core_reactor::procedural::{self, write_varint, OP_ARITH, OP_FILL, OP_LITERAL, OP_REPEAT};
use core_reactor::recipe::Recipe;
use std::sync::Arc;
use std::time::Instant;

const LIMIT: usize = 128 << 20;

fn no_dict(_: &DictId) -> Option<Arc<Vec<u8>>> {
    None
}

fn proc_recipe(level: i32, f: Filter, s: u8) -> Recipe {
    Recipe::new(Codec::Procedural, level).with_filter(f, s)
}

fn encode(data: &[u8]) -> Vec<u8> {
    proc_recipe(3, Filter::None, 0).encode(data, None).unwrap()
}

fn ops(blob: &[u8]) -> Vec<(u8, u64, u64)> {
    procedural::program_summary(&blob[HEADER_LEN..]).unwrap()
}

fn mask(w: usize) -> u64 {
    if w == 8 {
        u64::MAX
    } else {
        (1u64 << (8 * w)) - 1
    }
}

/// Reference ARITH generator (independent of the codec implementation).
fn arith(w: usize, be: bool, k: usize, start: u64, delta: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(k * w);
    for i in 0..k as u64 {
        let v = start.wrapping_add(i.wrapping_mul(delta)) & mask(w);
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

/// Random bytes in which no byte equals its predecessor (no accidental fills at boundaries).
fn noise(n: usize, seed: u64) -> Vec<u8> {
    let mut r = Lcg(seed);
    let mut out: Vec<u8> = Vec::with_capacity(n);
    while out.len() < n {
        let b = r.next() as u8;
        if out.last() != Some(&b) {
            out.push(b);
        }
    }
    out
}

const ARITH_CASES: [(usize, bool); 7] = [(1, false), (2, false), (2, true), (4, false), (4, true), (8, false), (8, true)];

fn mixed(seed: u64) -> Vec<u8> {
    let mut d = text(3_000, seed);
    d.extend(vec![0u8; 5_000]);
    d.extend(arith(4, false, 4_000, 7, 3));
    d.extend(periodic(&noise(700, seed + 1), 20_000));
    d.extend(random_bytes(2_000, seed + 2));
    d.extend(arith(8, true, 500, u64::MAX - 5, 0x0123_4567_89ab_cdef));
    d.extend(vec![0xEE; 33]);
    d.extend(f32_sensor(1_000, seed + 3));
    d.extend(arith(2, true, 3_000, 0xFFF0, 0x0101));
    d.extend(periodic(b"abc", 999));
    d
}

fn datasets() -> Vec<(String, Vec<u8>)> {
    let mut v: Vec<(String, Vec<u8>)> = vec![
        ("empty".into(), vec![]),
        ("one".into(), vec![0x42]),
        ("two".into(), vec![1, 2]),
        ("fill".into(), vec![0xAB; 100_000]),
        ("fills".into(), {
            let mut d = Vec::new();
            for i in 0..300usize {
                d.extend(vec![(i % 7) as u8; 1 + (i * 37) % 200]);
                d.extend(noise(i % 5, i as u64));
            }
            d
        }),
        ("periodic3".into(), periodic(b"xyz", 50_000)),
        ("periodic4000".into(), periodic(&random_bytes(4_000, 9), 120_000)),
        ("mixed".into(), mixed(1)),
        ("random".into(), random_bytes(50_000, 3)),
        ("text".into(), text(20_000, 4)),
        ("json".into(), json_logs(20_000, 5)),
        ("f32".into(), f32_sensor(5_000, 6)),
    ];
    for (w, be) in ARITH_CASES {
        // wrapping start and delta (delta > half the range = "negative")
        let start = mask(w) - 2;
        let delta = mask(w) - (w as u64) * 3;
        v.push((format!("arith{}{}_wrap", w, if be { "be" } else { "le" }), arith(w, be, 3_001, start, delta)));
        v.push((format!("arith{}{}_up", w, if be { "be" } else { "le" }), arith(w, be, 2_000, 0, 1)));
    }
    v
}

fn filter_combos() -> Vec<(Filter, u8)> {
    let mut v = vec![(Filter::None, 0)];
    for f in [Filter::Delta, Filter::Shuffle] {
        for s in STRIDES {
            v.push((f, s));
        }
    }
    v
}

#[test]
fn roundtrip_datasets_filters_levels() {
    let mut count = 0;
    for (name, data) in datasets() {
        for (f, s) in filter_combos() {
            for level in [1, 19] {
                let r = proc_recipe(level, f, s);
                r.validate().unwrap();
                let blob = r.encode(&data, None).unwrap();
                assert_eq!(blob[2], 5, "codec id");
                let out = decode_v2(&blob, LIMIT, &no_dict).unwrap_or_else(|e| panic!("{} {}: {}", name, r.label(), e));
                assert_eq!(out, data, "{} {}", name, r.label());
                assert_eq!(decode_any(&blob, LIMIT, &no_dict).unwrap(), data);
                count += 1;
            }
        }
    }
    assert!(count >= 400, "{}", count);
}

#[test]
fn encoder_uses_the_expected_ops() {
    // pure fill: one FILL, no literal stream at all
    let b = encode(&[7u8; 10_000]);
    assert_eq!(ops(&b), vec![(OP_FILL, 10_000, 7)]);
    // program_len varint (1) + FILL (1 + 2 + 1)
    assert_eq!(b.len(), HEADER_LEN + 5);
    // every ARITH width/endian, wrapping, exactly one ARITH op
    for (w, be) in ARITH_CASES {
        let d = arith(w, be, 1_000, mask(w) - 1, mask(w) / 3 + 5);
        let o = ops(&encode(&d));
        assert_eq!(o, vec![(OP_ARITH, (1_000 * w) as u64, w as u64 + if be { 100 } else { 0 })], "w{} be{}", w, be);
    }
    // periodic: first period literal, then one REPEAT
    let pat = noise(1_000, 11);
    let o = ops(&encode(&periodic(&pat, 50_000)));
    assert_eq!(o, vec![(OP_LITERAL, 1_000, 0), (OP_REPEAT, 49_000, 1_000)]);
    // random: a single LITERAL
    assert_eq!(ops(&encode(&random_bytes(10_000, 1))), vec![(OP_LITERAL, 10_000, 0)]);
    // mixed: adjacent literals merged (never two LITERAL ops in a row)
    let o = ops(&encode(&mixed(2)));
    assert!(o.windows(2).all(|w| !(w[0].0 == OP_LITERAL && w[1].0 == OP_LITERAL)), "{:?}", o);
    for code in [OP_LITERAL, OP_FILL, OP_REPEAT, OP_ARITH] {
        assert!(o.iter().any(|x| x.0 == code), "op {} missing in {:?}", code, o);
    }
}

/// `core` between noise whose boundary bytes differ from the core's ends (no accidental extension).
fn surrounded(core: &[u8], seed: u64) -> Vec<u8> {
    let (first, last) = (core[0], core[core.len() - 1]);
    let pick = |b: u8| (0..=255u8).map(|d| b.wrapping_add(d)).find(|c| *c != first && *c != last).unwrap();
    let mut d = noise(40, seed);
    let l = d.len() - 1;
    d[l] = pick(d[l]);
    d.extend_from_slice(core);
    let mut tail = noise(40, seed + 1);
    tail[0] = pick(tail[0]);
    d.extend(tail);
    d
}

#[test]
fn thresholds_are_exact() {
    // FILL >= 32 (a 16..31 run is still an ARITH w=1 delta 0 run, never a FILL)
    for (n, expect) in [(32usize, true), (31, false), (33, true)] {
        let o = ops(&encode(&surrounded(&vec![0x00; n], 100)));
        assert_eq!(o.iter().any(|x| x.0 == OP_FILL && x.1 == n as u64), expect, "fill {}: {:?}", n, o);
    }
    let o = ops(&encode(&surrounded(&[0x55; 15], 100)));
    assert!(o.iter().all(|x| x.0 == OP_LITERAL), "{:?}", o);

    // ARITH >= 16 elements, each width and endian
    for (w, be) in ARITH_CASES {
        for (k, expect) in [(16usize, true), (15, false)] {
            let d = surrounded(&arith(w, be, k, 0x1357_9bdf_0246_8ace & mask(w), 0x0f1e_2d3c_4b5a_6978 & mask(w)), 7);
            let o = ops(&encode(&d));
            let found = o.iter().any(|x| x.0 == OP_ARITH && x.1 == (k * w) as u64);
            assert_eq!(found, expect, "arith w{} be{} k{}: {:?}", w, be, k, o);
            if !expect {
                assert!(o.iter().all(|x| x.0 == OP_LITERAL), "w{} be{} k{}: {:?}", w, be, k, o);
            }
        }
    }

    // REPEAT: period <= 64 KiB, copy >= 3 periods (4 counting the source) and >= 64 bytes
    for (p, copy, expect) in [
        (5usize, 64usize, true),
        (5, 63, false),
        (30, 90, true),
        (30, 89, false),
        (1_000, 3_000, true),
        (1_000, 2_999, false),
        (65_536, 3 * 65_536, true),
        (65_537, 3 * 65_537, false),
    ] {
        let pat = noise(p, p as u64);
        let core = periodic(&pat, p + copy);
        let o = ops(&encode(&surrounded(&core, 3)));
        let found = o.iter().any(|x| x.0 == OP_REPEAT && x.2 == p as u64 && x.1 == copy as u64);
        assert_eq!(found, expect, "repeat p{} copy{}: {:?}", p, copy, o);
        if !expect {
            assert!(!o.iter().any(|x| x.0 == OP_REPEAT), "p{} copy{}: {:?}", p, copy, o);
        }
        assert_eq!(decode_v2(&encode(&core), LIMIT, &no_dict).unwrap(), core);
    }
}

// ---------------------------------------------------------------------------------------------
// Decoder rules (hand-built programs)
// ---------------------------------------------------------------------------------------------

fn varint(v: u64) -> Vec<u8> {
    let mut b = Vec::new();
    write_varint(&mut b, v);
    b
}

fn payload(prog: &[u8], lits: &[u8]) -> Vec<u8> {
    let mut p = varint(prog.len() as u64);
    p.extend_from_slice(prog);
    if !lits.is_empty() {
        p.extend(zstd::bulk::compress(lits, 3).unwrap());
    }
    p
}

fn blob_for(original: &[u8], filter: Filter, stride: u8, payload: &[u8]) -> Vec<u8> {
    let mut b = vec![0x10, 1, 5, filter.id(), stride];
    b.extend((original.len() as u64).to_le_bytes());
    b.extend(crc32(original).to_le_bytes());
    b.extend([0u8; 32]);
    b.extend_from_slice(payload);
    b
}

fn blob(original_len: usize, payload: &[u8]) -> Vec<u8> {
    let mut b = blob_for(&[], Filter::None, 0, payload);
    b[5..13].copy_from_slice(&(original_len as u64).to_le_bytes());
    b
}

fn rejects(b: &[u8], needle: &str) {
    match decode_v2(b, LIMIT, &no_dict) {
        Err(DecodeError::Invalid(m)) => assert!(m.contains(needle), "expected '{}', got '{}'", needle, m),
        other => panic!("expected rejection '{}', got {:?}", needle, other.map(|v| v.len())),
    }
}

/// The spec example: every op once, ARITH wrapping and big-endian.
fn spec_program() -> (Vec<u8>, Vec<u8>) {
    let mut prog = vec![OP_FILL, 10, b'a', OP_LITERAL, 3, OP_REPEAT, 4, 8, OP_ARITH, 2, 1, 3, 0x02, 0x01, 0x01, 0x00];
    prog.extend([OP_ARITH, 4, 0, 2, 0xFE, 0xFF, 0xFF, 0xFF, 3, 0, 0, 0]);
    let mut expected = b"aaaaaaaaaaxyzaxyzaxyz".to_vec();
    expected.extend([0x01, 0x02, 0x01, 0x03, 0x01, 0x04]);
    expected.extend([0xFE, 0xFF, 0xFF, 0xFF, 0x01, 0x00, 0x00, 0x00]);
    (payload(&prog, b"xyz"), expected)
}

#[test]
fn spec_program_decodes() {
    let (p, expected) = spec_program();
    let b = blob_for(&expected, Filter::None, 0, &p);
    assert_eq!(decode_v2(&b, LIMIT, &no_dict).unwrap(), expected);
    // ops apply to filtered bytes: the same program under delta/1 decodes to the inverse filter
    let unfiltered = codec::unapply_filter(Filter::Delta, 1, expected.clone());
    let b = blob_for(&unfiltered, Filter::Delta, 1, &p);
    assert_eq!(decode_v2(&b, LIMIT, &no_dict).unwrap(), unfiltered);
}


#[test]
fn decoder_rejects_every_rule() {
    let lit = |prog: &[u8], lits: &[u8], n: usize| blob(n, &payload(prog, lits));

    // unknown op
    for op in [0x00u8, 0x05, 0x80, 0xFF] {
        rejects(&lit(&[OP_FILL, 4, 1, op], b"", 4), "unknown op");
    }
    // varint overflow / truncation (in the program and in program_len)
    let mut over = vec![OP_FILL];
    over.extend([0xFF; 9]);
    over.extend([0x02, 0x00]);
    rejects(&lit(&over, b"", 4), "overflows");
    let mut over11 = vec![OP_FILL];
    over11.extend([0x80; 10]);
    over11.extend([0x00, 0x00]);
    rejects(&lit(&over11, b"", 4), "overflows");
    rejects(&lit(&[OP_FILL, 0x84], b"", 4), "truncated varint");
    rejects(&lit(&[OP_REPEAT, 1], b"", 4), "truncated varint");
    rejects(&blob(4, &[0x80]), "truncated varint");
    rejects(&blob(0, &[]), "truncated varint");
    // op would exceed the original length (each op kind)
    rejects(&lit(&[OP_FILL, 5, 1], b"", 4), "FILL op exceeds");
    rejects(&lit(&[OP_LITERAL, 5], b"abcde", 4), "LITERAL op exceeds");
    rejects(&lit(&[OP_FILL, 2, 1, OP_REPEAT, 1, 3], b"", 4), "REPEAT op exceeds");
    rejects(&lit(&[OP_ARITH, 2, 0, 3, 0, 0, 1, 0], b"", 5), "ARITH op exceeds");
    let mut huge_k = vec![OP_ARITH, 2, 0];
    huge_k.extend(varint(1 << 62));
    huge_k.extend([0, 0, 1, 0]);
    rejects(&lit(&huge_k, b"", 4), "ARITH op exceeds");
    // total output != original length
    rejects(&lit(&[OP_FILL, 3, 1], b"", 4), "produces 3");
    rejects(&lit(&[], b"", 4), "produces 0");
    // LITERAL beyond the literal stream
    rejects(&lit(&[OP_LITERAL, 5], b"abc", 5), "beyond the literal stream");
    rejects(&lit(&[OP_LITERAL, 5], b"", 5), "beyond the literal stream");
    // literal stream with unused trailing bytes
    rejects(&lit(&[OP_LITERAL, 3], b"abcde", 3), "unused");
    rejects(&lit(&[OP_FILL, 3, 1], b"abc", 3), "unused");
    let mut trailing = payload(&[OP_LITERAL, 3], b"abc");
    trailing.push(0);
    rejects(&blob(3, &trailing), "trailing bytes after the literal stream");
    let mut junk_only = payload(&[OP_FILL, 3, 1], b"");
    junk_only.push(0x99);
    rejects(&blob(3, &junk_only), "unused");
    // REPEAT p invalid: 0, beyond output, > 16 MiB
    rejects(&lit(&[OP_FILL, 2, 1, OP_REPEAT, 0, 2], b"", 4), "invalid REPEAT period 0");
    rejects(&lit(&[OP_FILL, 2, 1, OP_REPEAT, 3, 2], b"", 4), "invalid REPEAT period 3");
    rejects(&lit(&[OP_REPEAT, 1, 1], b"", 1), "invalid REPEAT period 1");
    let big = (16usize << 20) + 1;
    let mut prog = vec![OP_FILL];
    prog.extend(varint(big as u64));
    prog.push(9);
    let mut bad = prog.clone();
    bad.push(OP_REPEAT);
    bad.extend(varint(big as u64));
    bad.push(1);
    rejects(&lit(&bad, b"", big + 1), "invalid REPEAT period");
    let mut ok = prog.clone();
    ok.push(OP_REPEAT);
    ok.extend(varint(16 << 20));
    ok.push(1);
    let original = vec![9u8; big + 1];
    assert_eq!(decode_v2(&blob_for(&original, Filter::None, 0, &payload(&ok, b"")), LIMIT, &no_dict).unwrap(), original);
    // ARITH width / endian invalid, k*w overflow, truncated start/delta
    for w in [0u8, 3, 5, 7, 16, 255] {
        rejects(&lit(&[OP_ARITH, w, 0, 1, 0, 0], b"", 1), "invalid ARITH width");
    }
    for e in [2u8, 255] {
        rejects(&lit(&[OP_ARITH, 1, e, 1, 0, 0], b"", 1), "invalid ARITH endian");
    }
    let mut ovf = vec![OP_ARITH, 8, 0];
    ovf.extend(varint(u64::MAX / 4));
    ovf.extend([0u8; 16]);
    rejects(&lit(&ovf, b"", 8), "ARITH length overflows");
    rejects(&lit(&[OP_ARITH, 4, 0, 1, 0, 0, 0, 0, 1, 0], b"", 4), "truncated op");
    rejects(&lit(&[OP_ARITH, 4], b"", 4), "truncated op");
    rejects(&lit(&[OP_FILL, 4], b"", 4), "truncated");
    // program_len beyond payload
    let mut p = varint(100);
    p.extend([OP_FILL, 4, 1]);
    rejects(&blob(4, &p), "program length");
    // a corrupt literal frame is an error, not a panic
    let mut p = payload(&[OP_LITERAL, 3], b"abc");
    let last = p.len() - 1;
    p[last] ^= 0xFF;
    assert!(decode_v2(&blob(3, &p), LIMIT, &no_dict).is_err());
    // header CRC still applies
    let (p, expected) = spec_program();
    let mut b = blob_for(&expected, Filter::None, 0, &p);
    b[13] ^= 1;
    rejects(&b, "CRC");
}

#[test]
fn programs_cannot_become_bombs() {
    // 1 TiB FILL in 6 bytes: rejected by the header limit, or by the op check when the header lies
    let mut prog = vec![OP_FILL];
    prog.extend(varint(1 << 40));
    prog.push(0);
    let p = payload(&prog, b"");
    match decode_v2(&blob(1 << 40, &p), LIMIT, &no_dict) {
        Err(DecodeError::Invalid(m)) => assert!(m.contains("exceeds output limit"), "{}", m),
        other => panic!("{:?}", other.map(|v| v.len())),
    }
    rejects(&blob(1024, &p), "FILL op exceeds");
    // many tiny REPEATs whose sum exceeds the length are rejected before any output is produced
    let mut prog = vec![OP_FILL, 1, 0];
    for _ in 0..10_000 {
        prog.extend([OP_REPEAT, 1, 0x80, 0x80, 0x01]);
    }
    rejects(&blob(1 << 20, &payload(&prog, b"")), "REPEAT op exceeds");
}

#[test]
fn fuzz_corruptions_never_panic() {
    let mut seeds: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for (i, (f, s)) in [(Filter::None, 0u8), (Filter::Delta, 4), (Filter::Shuffle, 2), (Filter::Delta, 1)].into_iter().enumerate() {
        let data = mixed(10 + i as u64)[..20_000 + i * 3_000].to_vec();
        seeds.push((proc_recipe(3, f, s).encode(&data, None).unwrap(), data));
    }
    let (p, expected) = spec_program();
    seeds.push((blob_for(&expected, Filter::None, 0, &p), expected));
    let small: Vec<u8> = [vec![1u8; 40], arith(4, true, 20, 5, 9), periodic(b"hello", 80)].concat();
    seeds.push((encode(&small), small));

    let mut rng = Lcg(0x5EED_0005);
    let (mut errors, mut exact) = (0, 0);
    for i in 0..2000 {
        let (blob, original) = &seeds[i % seeds.len()];
        let mut b = blob.clone();
        let prog_end = HEADER_LEN + 1 + procedural::read_varint(&b[HEADER_LEN..], &mut 0).unwrap() as usize;
        match rng.below(7) {
            0 => {
                for _ in 0..=rng.below(4) {
                    let p = rng.below(b.len() as u64) as usize;
                    b[p] ^= 1 << rng.below(8);
                }
            }
            1 => {
                let p = rng.below(HEADER_LEN as u64) as usize;
                b[p] = rng.next() as u8;
            }
            2 => {
                // corrupt the program specifically
                let span = (prog_end.min(b.len()) - HEADER_LEN) as u64;
                for _ in 0..=rng.below(3) {
                    let p = HEADER_LEN + rng.below(span) as usize;
                    b[p] = rng.next() as u8;
                }
            }
            3 => {
                let n = rng.below(b.len() as u64) as usize;
                b.truncate(n);
            }
            4 => {
                let p = rng.below(b.len() as u64 + 1) as usize;
                for _ in 0..=rng.below(16) {
                    b.insert(p, rng.next() as u8);
                }
            }
            5 => {
                if b.len() > HEADER_LEN {
                    let p = HEADER_LEN + rng.below((b.len() - HEADER_LEN) as u64) as usize;
                    b[p] = rng.next() as u8;
                }
            }
            _ => b[5..13].copy_from_slice(&(rng.next() % (1 << 24)).to_le_bytes()),
        }
        match decode_v2(&b, 32 << 20, &no_dict) {
            Ok(out) => {
                assert_eq!(&out, original, "corruption {} decoded to different bytes", i);
                exact += 1;
            }
            Err(_) => errors += 1,
        }
        // the raw payload decoder must never panic either, whatever length is claimed
        if b.len() > HEADER_LEN {
            let _ = procedural::decode(&b[HEADER_LEN..], (rng.next() % 100_000) as usize);
            let _ = procedural::program_summary(&b[HEADER_LEN..]);
        }
    }
    assert_eq!(errors + exact, 2000);
    assert!(errors > 1500, "errors {} exact {}", errors, exact);
}

// ---------------------------------------------------------------------------------------------
// Ratio and overhead
// ---------------------------------------------------------------------------------------------

/// 64 MiB: 24 MiB u32 LE counter + 16 MiB fill + 24 MiB of a 1000-byte random block repeated.
pub fn procedural_sample() -> Vec<u8> {
    let mut d = Vec::with_capacity(64 << 20);
    for i in 0..(6u32 << 20) {
        d.extend_from_slice(&i.wrapping_mul(3).wrapping_add(7).to_le_bytes());
    }
    d.resize(40 << 20, 0x5A);
    let block = random_bytes(1_000, 42);
    while d.len() < 64 << 20 {
        let take = block.len().min((64 << 20) - d.len());
        d.extend_from_slice(&block[..take]);
    }
    d
}

#[test]
fn procedural_sample_exceeds_32000x() {
    let data = procedural_sample();
    assert_eq!(data.len(), 64 << 20);
    let r = Recipe::new(Codec::Procedural, 19);
    let t = Instant::now();
    let blob = r.encode(&data, None).unwrap();
    let enc = t.elapsed();
    let t = Instant::now();
    let out = decode_v2(&blob, LIMIT, &no_dict).unwrap();
    let dec = t.elapsed();
    assert!(out == data, "round-trip mismatch");
    let ratio = data.len() as f64 / blob.len() as f64;
    println!(
        "procedural 64 MiB sample: {} bytes -> {} bytes, ratio {:.0}x (debug build: enc {:?}, dec {:?}); ops {:?}",
        data.len(),
        blob.len(),
        ratio,
        enc,
        dec,
        ops(&blob)
    );
    assert!(ratio > 32_000.0, "ratio {}", ratio);
}

#[test]
fn random_data_costs_only_a_few_bytes() {
    for n in [1usize, 100, 10_000, 1 << 20] {
        let data = random_bytes(n, n as u64);
        let raw = Recipe::new(Codec::Raw, 0).encode(&data, None).unwrap();
        let p = encode(&data);
        assert_eq!(decode_v2(&p, LIMIT, &no_dict).unwrap(), data);
        // program (~6 bytes) + zstd frame header and 3 bytes per raw 128 KiB block
        let overhead = p.len() as i64 - raw.len() as i64;
        let allowed = 16 + 3 * n.div_ceil(128 << 10) as i64;
        println!("random {} bytes: procedural overhead over raw v2 = {} bytes", n, overhead);
        assert!(overhead <= allowed, "n {} overhead {}", n, overhead);
    }
    // /compress never stores more than legacy raw (high entropy is not evolved at all)
    let dir = tempfile::tempdir().unwrap();
    let engine = ratio_only_engine(dir.path(), 1);
    let rnd = random_bytes(200_000, 77);
    let out = engine.compress(&rnd, None, false);
    assert_eq!(out.blob[0], 0x02);
    assert_eq!(out.blob.len(), rnd.len() + 1);
}

// ---------------------------------------------------------------------------------------------
// Evolution
// ---------------------------------------------------------------------------------------------

/// Machine-generated record dumps: counters of several widths/endians, padding and a repeated
/// header block — exactly what a procedural program describes.
fn procedural_doc(seed: u64) -> Vec<u8> {
    let mut d = Vec::new();
    d.extend(arith(4, false, 8_000, seed * 1000, 3 + seed));
    d.extend(vec![0u8; 20_000 + seed as usize * 100]);
    d.extend(arith(2, true, 6_000, seed, 0x0101));
    d.extend(periodic(&noise(48, seed), 30_000));
    d.extend(arith(8, false, 3_000, u64::MAX - seed, 0x0001_0000_0001_0003));
    d.extend(vec![0xFFu8; 10_000]);
    d
}

#[test]
fn evolution_picks_procedural_only_where_it_wins() {
    let dir = tempfile::tempdir().unwrap();
    let engine = ratio_only_engine(dir.path(), 5);
    let docs: Vec<Vec<u8>> = (0..8).map(procedural_doc).collect();
    let class = engine.compress(&docs[0], None, true).class;
    for d in &docs[1..] {
        let out = engine.compress(d, None, true);
        assert_eq!(out.class, class);
        assert_eq!(decode_any(&out.blob, LIMIT, &no_dict).unwrap(), *d);
    }
    let first = engine.run_generation(class).unwrap();
    let proc_member = first.scored.iter().find(|m| m.recipe.codec == Codec::Procedural).expect("procedural seeded");
    let best_other = first.scored.iter().filter(|m| m.recipe.codec != Codec::Procedural).find_map(|m| m.score.clone()).unwrap();
    let champ = first.champion.unwrap();
    println!(
        "{}: procedural ratio {:.0}x vs best other {:.0}x; champion {}",
        class,
        proc_member.score.as_ref().unwrap().ratio,
        best_other.ratio,
        champ.recipe.label()
    );
    assert_eq!(champ.recipe.codec, Codec::Procedural, "champion {}", champ.recipe.label());
    // /compress now emits codec 5 blobs that decode exactly
    let fresh = procedural_doc(99);
    let out = engine.compress(&fresh, None, false);
    assert_eq!(out.recipe.as_ref().map(|r| r.codec), Some(Codec::Procedural));
    assert_eq!(out.blob[2], 5);
    assert_eq!(decode_any(&out.blob, LIMIT, &no_dict).unwrap(), fresh);

    // on ordinary JSON it is scored and loses
    let json: Vec<Vec<u8>> = (0..6).map(|i| json_logs(30_000, i)).collect();
    for d in &json {
        engine.compress(d, None, true);
    }
    let r = engine.run_generation(TEXT_JSON).unwrap();
    assert!(r.scored.iter().any(|m| m.recipe.codec == Codec::Procedural && m.score.is_some()));
    assert_ne!(r.champion.unwrap().recipe.codec, Codec::Procedural);
}

#[test]
fn mutation_can_switch_to_procedural() {
    use core_reactor::evolution::mutate;
    use rand::SeedableRng;
    let mut rng = rand_chacha::ChaCha8Rng::seed_from_u64(3);
    let mut seen = false;
    for _ in 0..2_000 {
        let mut r = Recipe::new(Codec::Zstd, 9);
        mutate(&mut r, &mut rng, None);
        r.validate().unwrap();
        seen |= r.codec == Codec::Procedural;
    }
    assert!(seen);
}

/// `cargo test --release --test procedural -- --ignored --nocapture`
#[test]
#[ignore]
fn bench_procedural_64mib() {
    let mib = 64.0;
    let rnd = random_bytes(64 << 20, 1);
    let t = Instant::now();
    let z = zstd::bulk::compress(&rnd, 3).unwrap();
    println!("(reference) zstd-3 alone on random: {:.0} MiB/s, {} bytes", mib / t.elapsed().as_secs_f64(), z.len());
    for (name, data) in [("random", rnd), ("procedural", procedural_sample())] {
        let r = Recipe::new(Codec::Procedural, 3);
        let t = Instant::now();
        let blob = r.encode(&data, None).unwrap();
        let enc = t.elapsed().as_secs_f64();
        let t = Instant::now();
        let out = decode_v2(&blob, LIMIT, &no_dict).unwrap();
        let dec = t.elapsed().as_secs_f64();
        assert!(out == data);
        println!(
            "{:<10} 64 MiB -> {} bytes ({:.1}x): encode {:.0} MiB/s, decode {:.0} MiB/s",
            name,
            blob.len(),
            data.len() as f64 / blob.len() as f64,
            mib / enc,
            mib / dec
        );
    }
}
