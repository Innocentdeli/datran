mod common;

use common::*;
use core_reactor::codec::{
    self, decode_any, decode_v2, Codec, DecodeError, DictId, Filter, HEADER_LEN, STRIDES,
};
use core_reactor::recipe::Recipe;
use std::sync::Arc;

const LIMIT: usize = 64 << 20;

fn no_dict(_: &DictId) -> Option<Arc<Vec<u8>>> {
    None
}

fn levels(c: Codec) -> Vec<(i32, Option<u32>)> {
    match c {
        Codec::Raw | Codec::Lz4 => vec![(0, None)],
        Codec::Deflate => vec![(0, None), (1, None), (6, None), (9, None)],
        Codec::Zstd => vec![(1, None), (3, Some(10)), (9, None), (19, Some(27))],
        Codec::Brotli => vec![(0, None), (5, Some(10)), (11, Some(24))],
        Codec::Procedural => vec![(1, None), (19, None)],
    }
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

fn datasets() -> Vec<(&'static str, Vec<u8>)> {
    vec![
        ("text", text(20_000, 1)),
        ("json", json_logs(12_000, 2)),
        ("f32", f32_sensor(4_000, 3)),
        ("f32_odd", {
            let mut d = f32_sensor(250, 4);
            d.extend_from_slice(&[1, 2, 3]);
            d
        }),
        ("random", random_bytes(4_096, 5)),
        ("empty", vec![]),
        ("one", vec![0x42]),
        ("tiny", vec![9, 8, 7, 6, 5]),
    ]
}

#[test]
fn roundtrip_every_codec_filter_stride_level() {
    let mut count = 0;
    for (name, data) in datasets() {
        for codec in Codec::ALL {
            for (level, wl) in levels(codec) {
                for (f, s) in filter_combos() {
                    let r = Recipe::new(codec, level).with_window(wl).with_filter(f, s);
                    r.validate().unwrap();
                    let blob = r
                        .encode(&data, None)
                        .unwrap_or_else(|e| panic!("{} {:?}: {}", name, r, e));
                    assert_eq!(blob[0], 0x10);
                    assert_eq!(blob[2], codec.id());
                    let out = decode_v2(&blob, LIMIT, &no_dict)
                        .unwrap_or_else(|e| panic!("{} {}: {}", name, r.label(), e));
                    assert_eq!(out, data, "{} {}", name, r.label());
                    assert_eq!(decode_any(&blob, LIMIT, &no_dict).unwrap(), data);
                    count += 1;
                }
            }
        }
    }
    assert!(count > 800, "{}", count);
}

fn train_dict() -> Vec<u8> {
    let samples: Vec<Vec<u8>> = (0..64).map(small_json).collect();
    zstd::dict::from_samples(&samples, 8 * 1024).expect("train")
}

#[test]
fn roundtrip_with_dictionary() {
    let dict = Arc::new(train_dict());
    let id = codec::sha256(&dict);
    let lookup = |i: &DictId| if *i == id { Some(dict.clone()) } else { None };
    let mut small_gain = false;
    for (name, data) in datasets()
        .into_iter()
        .chain([("small_json", small_json(999))])
    {
        for (level, wl) in levels(Codec::Zstd) {
            for (f, s) in filter_combos() {
                let r = Recipe::new(Codec::Zstd, level)
                    .with_window(wl)
                    .with_filter(f, s)
                    .with_dict(Some(&id));
                let blob = r.encode(&data, Some(&dict)).unwrap();
                assert_eq!(&blob[17..49], &id);
                assert_eq!(
                    decode_v2(&blob, LIMIT, &lookup).unwrap(),
                    data,
                    "{} {}",
                    name,
                    r.label()
                );
                assert_eq!(
                    decode_v2(&blob, LIMIT, &no_dict),
                    Err(DecodeError::UnknownDict(id))
                );
                // a different dictionary with the same id must fail the CRC / decode, never succeed wrongly
                let wrong = Arc::new(vec![0u8; 64]);
                if !data.is_empty() {
                    if let Ok(out) = decode_v2(&blob, LIMIT, &|_: &DictId| Some(wrong.clone())) {
                        assert_eq!(out, data);
                    }
                }
                if name == "small_json" && f == Filter::None && level == 3 {
                    let plain = Recipe::new(Codec::Zstd, 3).encode(&data, None).unwrap();
                    small_gain = blob.len() < plain.len();
                }
            }
        }
    }
    assert!(small_gain, "dictionary should help a small JSON record");
    assert!(Recipe::new(Codec::Zstd, 3)
        .with_dict(Some(&id))
        .encode(b"x", None)
        .is_err());
}

fn valid_blob(codec: Codec, f: Filter, s: u8) -> (Vec<u8>, Vec<u8>) {
    let data = json_logs(3_000, 7);
    let r = Recipe::new(codec, Recipe::default_level(codec)).with_filter(f, s);
    (r.encode(&data, None).unwrap(), data)
}

fn assert_invalid(blob: &[u8], limit: usize, what: &str) {
    match decode_v2(blob, limit, &no_dict) {
        Err(DecodeError::Invalid(_)) => {}
        other => panic!(
            "{}: expected Invalid, got {:?}",
            what,
            other.map(|v| v.len())
        ),
    }
}

#[test]
fn decoder_rejects_every_rule() {
    let (good, data) = valid_blob(Codec::Zstd, Filter::Shuffle, 4);
    assert_eq!(decode_v2(&good, LIMIT, &no_dict).unwrap(), data);

    // too short / truncated header
    for n in [0, 1, 5, 48] {
        assert_invalid(&good[..n], LIMIT, "short header");
    }
    // unknown version
    for v in [0u8, 2, 255] {
        let mut b = good.clone();
        b[1] = v;
        assert_invalid(&b, LIMIT, "version");
    }
    // unknown codec
    for c in [6u8, 7, 255] {
        let mut b = good.clone();
        b[2] = c;
        assert_invalid(&b, LIMIT, "codec");
    }
    // unknown filter
    for f in [3u8, 255] {
        let mut b = good.clone();
        b[3] = f;
        assert_invalid(&b, LIMIT, "filter");
    }
    // stride not in {1,2,4,8} with a filter
    for s in [0u8, 3, 5, 16, 255] {
        let mut b = good.clone();
        b[4] = s;
        assert_invalid(&b, LIMIT, "stride");
    }
    // filter none with stride != 0
    let (none_blob, _) = valid_blob(Codec::Deflate, Filter::None, 0);
    for s in [1u8, 4, 8] {
        let mut b = none_blob.clone();
        b[4] = s;
        assert_invalid(&b, LIMIT, "none+stride");
    }
    // dictionary set on non-zstd codecs
    for codec in [Codec::Raw, Codec::Lz4, Codec::Deflate, Codec::Brotli] {
        let (mut b, _) = valid_blob(codec, Filter::None, 0);
        b[17] = 1;
        assert_invalid(&b, LIMIT, "dict on non-zstd");
    }
    // original length > max output
    assert_invalid(&good, data.len() - 1, "limit");
    assert!(decode_v2(&good, data.len(), &no_dict).is_ok());
    let mut huge = good.clone();
    huge[5..13].copy_from_slice(&u64::MAX.to_le_bytes());
    assert_invalid(&huge, LIMIT, "u64 max length");

    // decoded length != original length, for every codec
    for codec in Codec::ALL {
        let (b, data) = valid_blob(codec, Filter::None, 0);
        for delta in [-1i64, 1, 1000] {
            let mut x = b.clone();
            x[5..13].copy_from_slice(&((data.len() as i64 + delta) as u64).to_le_bytes());
            assert_invalid(&x, LIMIT, &format!("length {} {:?}", delta, codec));
        }
        // CRC mismatch
        let mut x = b.clone();
        x[13] ^= 0x01;
        assert_invalid(&x, LIMIT, &format!("crc {:?}", codec));
        // trailing bytes after the stream
        for extra in [&[0u8][..], &[1, 2, 3], &b[HEADER_LEN..]] {
            let mut x = b.clone();
            x.extend_from_slice(extra);
            assert_invalid(&x, LIMIT, &format!("trailing {:?}", codec));
        }
        // truncated payload
        if b.len() > HEADER_LEN + 1 {
            assert_invalid(&b[..b.len() - 1], LIMIT, &format!("truncated {:?}", codec));
        }
    }

    // dictionary unknown
    let mut b = good.clone();
    b[17..49].copy_from_slice(&[7u8; 32]);
    assert!(
        matches!(decode_v2(&b, LIMIT, &no_dict), Err(DecodeError::UnknownDict(id)) if id == [7u8; 32])
    );

    // not a v2 flag through decode_v2; legacy still works through decode_any
    assert_invalid(&[0x02, 1, 2, 3], LIMIT, "legacy via v2");
    assert_eq!(
        decode_any(&[0x02, 1, 2, 3], LIMIT, &no_dict).unwrap(),
        vec![1, 2, 3]
    );
    assert!(decode_any(&[0x11; 60], LIMIT, &no_dict).is_err());
}

#[test]
fn decompression_bombs_are_capped() {
    let zeros = vec![0u8; 8 << 20];
    for codec in [Codec::Lz4, Codec::Deflate, Codec::Zstd, Codec::Brotli] {
        let mut b = Recipe::new(codec, Recipe::default_level(codec))
            .encode(&zeros, None)
            .unwrap();
        // under a smaller limit the header check rejects it
        assert_invalid(&b, 1 << 20, "bomb limit");
        // a lying small length must also fail, without inflating everything
        b[5..13].copy_from_slice(&1024u64.to_le_bytes());
        assert_invalid(&b, LIMIT, "bomb lie");
    }
}

#[test]
fn fuzz_corruptions_never_panic() {
    let dict = Arc::new(train_dict());
    let id = codec::sha256(&dict);
    let lookup = |i: &DictId| if *i == id { Some(dict.clone()) } else { None };
    let mut seeds: Vec<(Vec<u8>, Vec<u8>)> = Vec::new();
    for (i, codec) in Codec::ALL.into_iter().enumerate() {
        for (f, s) in [(Filter::None, 0), (Filter::Delta, 2), (Filter::Shuffle, 4)] {
            let data = if i % 2 == 0 {
                json_logs(2_000, i as u64)
            } else {
                f32_sensor(500, i as u64)
            };
            let r = Recipe::new(codec, Recipe::default_level(codec)).with_filter(f, s);
            seeds.push((r.encode(&data, None).unwrap(), data));
        }
    }
    let data = small_json(5);
    let r = Recipe::new(Codec::Zstd, 5).with_dict(Some(&id));
    seeds.push((r.encode(&data, Some(&dict)).unwrap(), data));

    let mut rng = Lcg(0xF022);
    let (mut errors, mut exact) = (0, 0);
    for i in 0..2000 {
        let (blob, original) = &seeds[i % seeds.len()];
        let mut b = blob.clone();
        match rng.below(6) {
            0 => {
                // flip 1-4 random bits anywhere
                for _ in 0..=rng.below(4) {
                    let p = rng.below(b.len() as u64) as usize;
                    b[p] ^= 1 << rng.below(8);
                }
            }
            1 => {
                // corrupt a header byte
                let p = rng.below(HEADER_LEN as u64) as usize;
                b[p] = rng.next() as u8;
            }
            2 => {
                // corrupt payload bytes
                if b.len() > HEADER_LEN {
                    for _ in 0..=rng.below(8) {
                        let p = HEADER_LEN + rng.below((b.len() - HEADER_LEN) as u64) as usize;
                        b[p] = rng.next() as u8;
                    }
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
            _ => {
                // random length field
                b[5..13].copy_from_slice(&(rng.next() % (1 << 24)).to_le_bytes());
            }
        }
        match decode_v2(&b, 32 << 20, &lookup) {
            Ok(out) => {
                assert_eq!(
                    &out, original,
                    "corruption {} decoded to different bytes",
                    i
                );
                exact += 1;
            }
            Err(_) => errors += 1,
        }
    }
    assert_eq!(errors + exact, 2000);
    assert!(errors > 1500, "errors {} exact {}", errors, exact);
}

#[test]
fn zstd_mt_with_overlapped_verify_is_one_standard_frame() {
    use core_reactor::codec::{decode_v2, encode_zstd_mt_verified, verify_v2, HEADER_LEN};
    let data = common::json_logs(6 << 20, 77);
    for (level, window) in [(1, None), (3, Some(20))] {
        let b = encode_zstd_mt_verified(level, window, None, &data, 4).unwrap();
        let payload = &b[HEADER_LEN..];
        assert_eq!(
            zstd::zstd_safe::find_frame_compressed_size(payload).ok(),
            Some(payload.len())
        );
        assert_eq!(
            zstd::zstd_safe::get_frame_content_size(payload)
                .ok()
                .flatten(),
            Some(data.len() as u64)
        );
        assert_eq!(decode_v2(&b, usize::MAX, &|_| None).unwrap(), data);
        verify_v2(&b, &data, &|_| None).unwrap();
        // the streaming verify rejects a blob that does not match the input
        let mut other = data.clone();
        other[123_456] ^= 1;
        assert!(verify_v2(&b, &other, &|_| None).is_err());
        let mut trailing = b.clone();
        trailing.push(0);
        assert!(verify_v2(&trailing, &data, &|_| None).is_err());
    }
}
