use flate2::read::DeflateDecoder;
use flate2::write::DeflateEncoder;
use flate2::Compression;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::OnceLock;

pub const FLAG_SYMBIT: u8 = 0x00;
pub const FLAG_ZLIB: u8 = 0x01;
pub const FLAG_RAW: u8 = 0x02;
pub const FLAG_LZ4: u8 = 0x03;

/// Default cap on decompressed output (2 GiB). Override with REACTOR_MAX_OUTPUT_BYTES.
pub const DEFAULT_MAX_OUTPUT: usize = 2 * 1024 * 1024 * 1024;

/// LZ4 block format can never expand more than ~255x (one extra length byte per 255 bytes).
const LZ4_MAX_RATIO: usize = 255;

/// Maximum decompressed size accepted by `decompress`.
pub fn max_output_bytes() -> usize {
    static LIMIT: OnceLock<usize> = OnceLock::new();
    *LIMIT.get_or_init(|| {
        std::env::var("REACTOR_MAX_OUTPUT_BYTES")
            .ok()
            .and_then(|v| v.trim().parse::<usize>().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_MAX_OUTPUT)
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CompressionResult {
    pub algorithm: String,
    pub original_size: usize,
    pub compressed_size: usize,
    pub ratio: f64,
    pub entropy: f64,
    pub duration_us: u128,
}

pub struct DiocomNativeReactor;

impl DiocomNativeReactor {
    /// Calculate Shannon Entropy across byte frequencies (0.0 to 8.0 bits/byte)
    #[inline]
    pub fn calculate_entropy(data: &[u8]) -> f64 {
        if data.is_empty() {
            return 0.0;
        }

        let mut counts = [0u32; 256];
        for &byte in data {
            counts[byte as usize] += 1;
        }

        let len_f = data.len() as f64;
        let mut entropy = 0.0;

        for &count in &counts {
            if count > 0 {
                let p = (count as f64) / len_f;
                entropy -= p * p.log2();
            }
        }

        entropy
    }

    /// Adaptive bare-metal compression
    pub fn compress(data: &[u8]) -> (CompressionResult, Vec<u8>) {
        let start = std::time::Instant::now();

        if data.is_empty() {
            return (
                CompressionResult {
                    algorithm: "raw".to_string(),
                    original_size: 0,
                    compressed_size: 1,
                    ratio: 1.0,
                    entropy: 0.0,
                    duration_us: start.elapsed().as_micros(),
                },
                vec![FLAG_RAW],
            );
        }

        let entropy = Self::calculate_entropy(data);

        // 1. High entropy (> 7.8): Already encrypted or compressed. Bypass CPU.
        if entropy >= 7.8 {
            let out = Self::frame(FLAG_RAW, data);
            let duration_us = start.elapsed().as_micros();
            let ratio = (data.len() as f64) / (out.len() as f64);

            return (
                CompressionResult {
                    algorithm: "raw_bypass".to_string(),
                    original_size: data.len(),
                    compressed_size: out.len(),
                    ratio,
                    entropy,
                    duration_us,
                },
                out,
            );
        }

        // 2. Low entropy (< 3.0): Symbit dictionary packing
        if entropy < 3.0 {
            if let Some(symbit_out) = Self::compress_symbit(data) {
                if symbit_out.len() < data.len() {
                    let duration_us = start.elapsed().as_micros();
                    let ratio = (data.len() as f64) / (symbit_out.len() as f64);
                    return (
                        CompressionResult {
                            algorithm: "symbit_native".to_string(),
                            original_size: data.len(),
                            compressed_size: symbit_out.len(),
                            ratio,
                            entropy,
                            duration_us,
                        },
                        symbit_out,
                    );
                }
            }
        }

        // 3. Medium entropy: Benchmark LZ4 vs Deflate
        let lz4_compressed = lz4_flex::compress_prepend_size(data);
        let deflate_compressed = Self::deflate(data);

        let (chosen_algo, out) = if !deflate_compressed.is_empty()
            && deflate_compressed.len() < lz4_compressed.len()
            && deflate_compressed.len() < data.len()
        {
            (
                "zlib_fast".to_string(),
                Self::frame(FLAG_ZLIB, &deflate_compressed),
            )
        } else if lz4_compressed.len() < data.len() {
            (
                "lz4_flex".to_string(),
                Self::frame(FLAG_LZ4, &lz4_compressed),
            )
        } else {
            ("raw".to_string(), Self::frame(FLAG_RAW, data))
        };

        let duration_us = start.elapsed().as_micros();
        let ratio = (data.len() as f64) / (out.len() as f64);

        (
            CompressionResult {
                algorithm: chosen_algo,
                original_size: data.len(),
                compressed_size: out.len(),
                ratio,
                entropy,
                duration_us,
            },
            out,
        )
    }

    fn frame(flag: u8, payload: &[u8]) -> Vec<u8> {
        let mut res = Vec::with_capacity(payload.len() + 1);
        res.push(flag);
        res.extend_from_slice(payload);
        res
    }

    fn deflate(data: &[u8]) -> Vec<u8> {
        let mut encoder = DeflateEncoder::new(Vec::new(), Compression::fast());
        if encoder.write_all(data).is_err() {
            return Vec::new();
        }
        encoder.finish().unwrap_or_default()
    }

    /// Symbit Bit-Packing Implementation
    ///
    /// Layout: Flag(1) | BitWidth(1, one of 1/2/4) | TotalItems(4, u32 BE) | MapSize-1 (1) |
    /// MapData(MapSize) | packed codes, MSB-first, last byte zero-padded on the right.
    fn compress_symbit(data: &[u8]) -> Option<Vec<u8>> {
        if data.is_empty() || data.len() > u32::MAX as usize {
            return None;
        }

        let mut counts = HashMap::new();
        for &b in data {
            *counts.entry(b).or_insert(0usize) += 1;
        }

        let mut sorted: Vec<(u8, usize)> = counts.into_iter().collect();
        sorted.sort_by_key(|e| std::cmp::Reverse(e.1));

        let unique_count = sorted.len();
        let bit_width: u8 = if unique_count <= 2 {
            1
        } else if unique_count <= 4 {
            2
        } else if unique_count <= 16 {
            4
        } else {
            return None;
        };

        let mut map = [0u8; 256];
        for (idx, &(byte, _)) in sorted.iter().enumerate() {
            map[byte as usize] = idx as u8;
        }

        let map_size = sorted.len() as u8;
        let mut out = Vec::with_capacity(data.len() / 2 + 16);
        out.push(FLAG_SYMBIT);
        out.push(bit_width);
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.push(map_size.saturating_sub(1));

        for &(byte, _) in &sorted {
            out.push(byte);
        }

        let mut current_byte = 0u8;
        let mut bits_filled = 0u8;

        for &b in data {
            let code = map[b as usize];
            current_byte = (current_byte << bit_width) | (code & ((1 << bit_width) - 1));
            bits_filled += bit_width;

            if bits_filled == 8 {
                out.push(current_byte);
                current_byte = 0;
                bits_filled = 0;
            }
        }

        if bits_filled > 0 {
            current_byte <<= 8 - bits_filled;
            out.push(current_byte);
        }

        Some(out)
    }

    /// Decompress a byte buffer produced by DiocomNativeReactor, capped at `max_output_bytes()`.
    pub fn decompress(data: &[u8]) -> Result<Vec<u8>, String> {
        Self::decompress_with_limit(data, max_output_bytes())
    }

    /// Decompress with an explicit output cap. Never panics on malformed input.
    pub fn decompress_with_limit(data: &[u8], limit: usize) -> Result<Vec<u8>, String> {
        if data.is_empty() {
            return Ok(Vec::new());
        }

        let flag = data[0];
        let payload = &data[1..];

        match flag {
            FLAG_RAW => {
                if payload.len() > limit {
                    return Err("Raw payload exceeds output limit".to_string());
                }
                Ok(payload.to_vec())
            }
            FLAG_LZ4 => Self::decompress_lz4(payload, limit),
            FLAG_ZLIB => {
                let decoder = DeflateDecoder::new(payload);
                let mut decompressed = Vec::new();
                decoder
                    .take((limit as u64).saturating_add(1))
                    .read_to_end(&mut decompressed)
                    .map_err(|e| format!("Zlib decompress failed: {}", e))?;
                if decompressed.len() > limit {
                    return Err(format!("Zlib output exceeds limit of {} bytes", limit));
                }
                Ok(decompressed)
            }
            FLAG_SYMBIT => Self::decompress_symbit(payload, limit),
            other => Err(format!("Unknown compression flag: 0x{:02x}", other)),
        }
    }

    /// LZ4 block with a 4-byte little-endian uncompressed-size prefix (lz4_flex::compress_prepend_size).
    fn decompress_lz4(payload: &[u8], limit: usize) -> Result<Vec<u8>, String> {
        if payload.len() < 4 {
            return Err("Invalid LZ4 payload: missing size prefix".to_string());
        }
        let declared =
            u32::from_le_bytes([payload[0], payload[1], payload[2], payload[3]]) as usize;
        let block = &payload[4..];

        if declared > limit {
            return Err(format!(
                "LZ4 declared size {} exceeds limit of {} bytes",
                declared, limit
            ));
        }
        if declared > block.len().saturating_mul(LZ4_MAX_RATIO).saturating_add(16) {
            return Err("LZ4 declared size impossible for payload length".to_string());
        }

        let out = lz4_flex::block::decompress(block, declared)
            .map_err(|e| format!("LZ4 decompress failed: {}", e))?;
        if out.len() != declared {
            return Err(format!(
                "LZ4 size mismatch: declared {}, got {}",
                declared,
                out.len()
            ));
        }
        Ok(out)
    }

    fn decompress_symbit(payload: &[u8], limit: usize) -> Result<Vec<u8>, String> {
        if payload.len() < 6 {
            return Err("Invalid symbit payload: too short".to_string());
        }

        let bit_width = payload[0];
        if !matches!(bit_width, 1 | 2 | 4) {
            return Err(format!("Invalid symbit bit width: {}", bit_width));
        }

        let total_items =
            u32::from_be_bytes([payload[1], payload[2], payload[3], payload[4]]) as usize;
        let map_size = (payload[5] as usize) + 1;
        let mut offset = 6;

        if map_size > (1usize << bit_width) {
            return Err("Invalid symbit dictionary: larger than code space".to_string());
        }
        if payload.len() < offset + map_size {
            return Err("Invalid symbit dictionary: truncated".to_string());
        }

        let dict = &payload[offset..offset + map_size];
        offset += map_size;

        if total_items > limit {
            return Err(format!(
                "Symbit item count {} exceeds limit of {} bytes",
                total_items, limit
            ));
        }

        let packed = &payload[offset..];
        let needed_bytes = total_items
            .checked_mul(bit_width as usize)
            .map(|bits| bits.div_ceil(8))
            .ok_or_else(|| "Symbit item count overflow".to_string())?;
        if packed.len() != needed_bytes {
            return Err(format!(
                "Symbit payload length mismatch: expected {} packed bytes, got {}",
                needed_bytes,
                packed.len()
            ));
        }

        let codes_per_byte = 8 / bit_width as usize;
        let bit_mask = (1u8 << bit_width) - 1;
        let mut out = Vec::with_capacity(total_items);

        'outer: for &byte in packed {
            for slot in 0..codes_per_byte {
                if out.len() == total_items {
                    break 'outer;
                }
                let shift = 8 - (slot + 1) * bit_width as usize;
                let code = ((byte >> shift) & bit_mask) as usize;
                match dict.get(code) {
                    Some(&b) => out.push(b),
                    None => return Err(format!("Symbit code {} outside dictionary", code)),
                }
            }
        }

        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg_bytes(n: usize, seed: u64) -> Vec<u8> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                (s >> 33) as u8
            })
            .collect()
    }

    fn text(n: usize) -> Vec<u8> {
        let words = [
            "alpha ", "beta ", "gamma ", "delta ", "reactor ", "datran ", "chunk\n",
        ];
        let picks = lcg_bytes(n, 42);
        let mut out = Vec::with_capacity(n + 16);
        let mut i = 0usize;
        while out.len() < n {
            let p = picks[i % picks.len()] as usize;
            out.extend_from_slice(words[p % words.len()].as_bytes());
            if p.is_multiple_of(5) {
                out.extend_from_slice(format!("{} ", p).as_bytes());
            }
            i += 1;
        }
        out.truncate(n);
        out
    }

    /// 64-byte pattern of 64 distinct symbols repeated: entropy 6.0, and LZ4 beats deflate
    /// because deflate's match length tops out at 258 bytes.
    fn lz4_favoured(n: usize) -> Vec<u8> {
        let pattern: Vec<u8> = (0..64u8)
            .map(|i| i.wrapping_mul(37).wrapping_add(11))
            .collect();
        pattern.iter().cycle().take(n).copied().collect()
    }

    fn symbit_data(n: usize, alphabet: usize) -> Vec<u8> {
        lcg_bytes(n, 7)
            .into_iter()
            .map(|b| b'A' + (b as usize % alphabet) as u8)
            .collect()
    }

    fn roundtrip(data: &[u8]) -> u8 {
        let (_, c) = DiocomNativeReactor::compress(data);
        let d = DiocomNativeReactor::decompress(&c).expect("decompress");
        assert_eq!(d, data, "round-trip mismatch (len {})", data.len());
        c[0]
    }

    #[test]
    fn roundtrip_empty_and_one_byte() {
        assert_eq!(roundtrip(&[]), FLAG_RAW);
        assert_eq!(roundtrip(&[0x42]), FLAG_RAW);
        assert_eq!(
            DiocomNativeReactor::decompress(&[]).unwrap(),
            Vec::<u8>::new()
        );
    }

    #[test]
    fn roundtrip_high_entropy_is_raw() {
        assert_eq!(roundtrip(&lcg_bytes(100_000, 1)), FLAG_RAW);
    }

    #[test]
    fn roundtrip_symbit_all_widths() {
        assert_eq!(roundtrip(&vec![0u8; 10_000]), FLAG_SYMBIT); // 1 symbol
        assert_eq!(roundtrip(&symbit_data(10_001, 2)), FLAG_SYMBIT); // 1-bit
        assert_eq!(roundtrip(&symbit_data(10_003, 4)), FLAG_SYMBIT); // 2-bit
                                                                     // 4-bit (entropy must be < 3.0, so skew the distribution)
        let mut skewed = symbit_data(10_005, 2);
        for i in (0..skewed.len()).step_by(13) {
            skewed[i] = b'a' + (i % 12) as u8;
        }
        assert_eq!(roundtrip(&skewed), FLAG_SYMBIT);
        assert_eq!(roundtrip(&symbit_data(3, 2)), FLAG_RAW); // too small to benefit
    }

    #[test]
    fn roundtrip_medium_entropy_deflate_and_lz4() {
        assert_eq!(roundtrip(&text(200_000)), FLAG_ZLIB);
        assert_eq!(roundtrip(&lz4_favoured(1_000_000)), FLAG_LZ4);
        for n in [1usize, 2, 17, 255, 4096, 65_537] {
            roundtrip(&text(n));
            roundtrip(&lz4_favoured(n));
            roundtrip(&lcg_bytes(n, n as u64));
        }
    }

    #[test]
    fn rejects_unknown_flag() {
        assert!(DiocomNativeReactor::decompress(&[0x09, 1, 2, 3]).is_err());
    }

    fn symbit_header(bit_width: u8, total: u32, map: &[u8]) -> Vec<u8> {
        let mut v = vec![FLAG_SYMBIT, bit_width];
        v.extend_from_slice(&total.to_be_bytes());
        v.push((map.len() as u8).wrapping_sub(1));
        v.extend_from_slice(map);
        v
    }

    #[test]
    fn symbit_malformed_inputs_error() {
        // bit width 0, 3, 8, 9
        for bw in [0u8, 3, 8, 9, 255] {
            let mut p = symbit_header(bw, 8, &[1, 2]);
            p.extend_from_slice(&[0u8; 8]);
            assert!(DiocomNativeReactor::decompress(&p).is_err(), "bw {}", bw);
        }
        // huge total_items with tiny payload
        let mut p = symbit_header(1, u32::MAX, &[1, 2]);
        p.extend_from_slice(&[0xAA; 4]);
        assert!(DiocomNativeReactor::decompress(&p).is_err());
        // total_items over output limit
        let mut p = symbit_header(1, 64, &[1, 2]);
        p.extend_from_slice(&[0xAA; 8]);
        assert!(DiocomNativeReactor::decompress_with_limit(&p, 63).is_err());
        assert_eq!(
            DiocomNativeReactor::decompress_with_limit(&p, 64)
                .unwrap()
                .len(),
            64
        );
        // truncated packed data
        let mut p = symbit_header(2, 100, &[1, 2, 3, 4]);
        p.extend_from_slice(&[0x1B; 10]);
        assert!(DiocomNativeReactor::decompress(&p).is_err());
        // dictionary larger than code space / truncated dictionary
        assert!(DiocomNativeReactor::decompress(&symbit_header(1, 0, &[1, 2, 3])).is_err());
        assert!(DiocomNativeReactor::decompress(&[FLAG_SYMBIT, 4, 0, 0, 0, 1, 15, 1]).is_err());
        // code outside dictionary (3 symbols in 2-bit space, code 3 used)
        let mut p = symbit_header(2, 4, &[1, 2, 3]);
        p.push(0b1111_1111);
        assert!(DiocomNativeReactor::decompress(&p).is_err());
        // header too short
        assert!(DiocomNativeReactor::decompress(&[FLAG_SYMBIT, 1, 0]).is_err());
    }

    #[test]
    fn lz4_malformed_inputs_error() {
        let (_, good) = DiocomNativeReactor::compress(&lz4_favoured(100_000));
        assert_eq!(good[0], FLAG_LZ4);
        // truncated payloads
        for cut in [1usize, 3, 5, good.len() / 2, good.len() - 1] {
            assert!(
                DiocomNativeReactor::decompress(&good[..cut]).is_err(),
                "cut {}",
                cut
            );
        }
        // declared size lies (too large / too small)
        let mut big = good.clone();
        big[1..5].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(DiocomNativeReactor::decompress(&big).is_err());
        let mut small = good.clone();
        small[1..5].copy_from_slice(&10u32.to_le_bytes());
        assert!(DiocomNativeReactor::decompress(&small).is_err());
        // over output limit
        assert!(DiocomNativeReactor::decompress_with_limit(&good, 99_999).is_err());
        // garbage
        assert!(DiocomNativeReactor::decompress(&[FLAG_LZ4, 5, 0, 0, 0, 0xFF, 0xFF]).is_err());
    }

    #[test]
    fn deflate_malformed_and_bomb_error() {
        let (_, good) = DiocomNativeReactor::compress(&text(50_000));
        assert_eq!(good[0], FLAG_ZLIB);
        assert!(DiocomNativeReactor::decompress(&good[..good.len() / 2]).is_err());
        assert!(DiocomNativeReactor::decompress(&[FLAG_ZLIB, 0xFF, 0xFF, 0xFF]).is_err());

        // Bomb: 64 MiB of zeros deflates to ~64 KiB; must be rejected under a 1 MiB limit.
        let bomb = DiocomNativeReactor::frame(
            FLAG_ZLIB,
            &DiocomNativeReactor::deflate(&vec![0u8; 64 << 20]),
        );
        assert!(bomb.len() < 1 << 20);
        let err = DiocomNativeReactor::decompress_with_limit(&bomb, 1 << 20).unwrap_err();
        assert!(err.contains("exceeds limit"), "{}", err);
    }

    #[test]
    fn raw_over_limit_errors() {
        assert!(DiocomNativeReactor::decompress_with_limit(&[FLAG_RAW, 1, 2, 3], 2).is_err());
    }

    /// Decodes fixtures written by the TypeScript encoder (`WRITE_TS_FIXTURES=1 npm test`).
    #[test]
    fn decodes_ts_fixtures() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        let mut seen_flags = std::collections::HashSet::new();
        let mut count = 0;
        for entry in std::fs::read_dir(&dir).expect("fixtures dir") {
            let path = entry.unwrap().path();
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if let Some(stem) = name.strip_suffix(".ts.bin") {
                let encoded = std::fs::read(&path).unwrap();
                let expected = std::fs::read(dir.join(format!("{}.input.bin", stem))).unwrap();
                let decoded = DiocomNativeReactor::decompress(&encoded)
                    .unwrap_or_else(|e| panic!("{}: {}", name, e));
                assert_eq!(decoded, expected, "{}", name);
                seen_flags.insert(encoded[0]);
                count += 1;
            }
        }
        assert!(count >= 5, "expected TS fixtures, found {}", count);
        for flag in [FLAG_SYMBIT, FLAG_ZLIB, FLAG_RAW] {
            assert!(
                seen_flags.contains(&flag),
                "no TS fixture with flag {}",
                flag
            );
        }
    }

    /// Writes cross-language fixtures for the TypeScript decoder tests.
    /// Run with: REACTOR_WRITE_FIXTURES=1 cargo test write_fixtures
    #[test]
    fn write_fixtures() {
        if std::env::var("REACTOR_WRITE_FIXTURES").is_err() {
            return;
        }
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
        std::fs::create_dir_all(&dir).unwrap();

        let mut skewed = symbit_data(10_005, 2);
        for i in (0..skewed.len()).step_by(13) {
            skewed[i] = b'a' + (i % 12) as u8;
        }
        let cases: Vec<(&str, Vec<u8>, u8)> = vec![
            ("empty", vec![], FLAG_RAW),
            ("one_byte", vec![0x7F], FLAG_RAW),
            ("random_64k", lcg_bytes(65_536, 99), FLAG_RAW),
            ("zeros_10k", vec![0u8; 10_000], FLAG_SYMBIT),
            ("symbit1_10001", symbit_data(10_001, 2), FLAG_SYMBIT),
            ("symbit2_10003", symbit_data(10_003, 4), FLAG_SYMBIT),
            ("symbit4_10005", skewed, FLAG_SYMBIT),
            ("text_100k", text(100_000), FLAG_ZLIB),
            ("lz4_pattern_300k", lz4_favoured(300_000), FLAG_LZ4),
        ];
        for (name, data, expected_flag) in cases {
            let (_, c) = DiocomNativeReactor::compress(&data);
            assert_eq!(c[0], expected_flag, "fixture {} flag", name);
            std::fs::write(dir.join(format!("{}.input.bin", name)), &data).unwrap();
            std::fs::write(dir.join(format!("{}.rs.bin", name)), &c).unwrap();
        }
        // Force LZ4 framing on literal-heavy / mixed data to exercise the TS LZ4 decoder.
        for (name, data) in [
            ("lz4_forced_text", text(150_000)),
            ("lz4_forced_random", lcg_bytes(20_000, 5)),
            (
                "lz4_forced_small",
                b"abcabcabcabcabcabcabcabcabcabcX".to_vec(),
            ),
        ] {
            let c = DiocomNativeReactor::frame(FLAG_LZ4, &lz4_flex::compress_prepend_size(&data));
            assert_eq!(DiocomNativeReactor::decompress(&c).unwrap(), data);
            std::fs::write(dir.join(format!("{}.input.bin", name)), &data).unwrap();
            std::fs::write(dir.join(format!("{}.rs.bin", name)), &c).unwrap();
        }
    }
}
