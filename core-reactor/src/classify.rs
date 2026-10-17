//! Content classification (spec §3): mime hint + magic bytes + text sniffing + entropy.

use crate::reactor::DiocomNativeReactor;

pub const EMPTY: &str = "empty";
pub const MEDIA_COMPRESSED: &str = "media/compressed";
pub const TEXT_JSON: &str = "text/json";
pub const TEXT_MARKUP: &str = "text/markup";
pub const TEXT_CSV: &str = "text/csv";
pub const TEXT_PLAIN: &str = "text/plain";
pub const BINARY_NUMERIC: &str = "binary/numeric";
pub const BINARY_STRUCTURED: &str = "binary/structured";

/// Every class the reactor can produce.
pub const CLASSES: [&str; 8] = [
    EMPTY,
    MEDIA_COMPRESSED,
    TEXT_JSON,
    TEXT_MARKUP,
    TEXT_CSV,
    TEXT_PLAIN,
    BINARY_NUMERIC,
    BINARY_STRUCTURED,
];

/// Classes that get a population and are evolved.
pub fn is_evolvable(class: &str) -> bool {
    class != EMPTY && class != MEDIA_COMPRESSED && CLASSES.contains(&class)
}

/// Canonical `&'static str` for a known class name (used for untrusted input such as gossip).
pub fn canonical(class: &str) -> Option<&'static str> {
    CLASSES.iter().copied().find(|c| *c == class)
}

const SNIFF_BYTES: usize = 64 * 1024;
const HIGH_ENTROPY: f64 = 7.5;

fn has_compressed_magic(d: &[u8]) -> bool {
    let starts = |m: &[u8]| d.starts_with(m);
    starts(&[0x1f, 0x8b]) // gzip
        || starts(b"PK\x03\x04") // zip / docx / jar
        || starts(&[0x28, 0xb5, 0x2f, 0xfd]) // zstd
        || starts(&[0xfd, b'7', b'z', b'X', b'Z', 0x00]) // xz
        || starts(b"BZh") // bzip2
        || starts(&[b'7', b'z', 0xbc, 0xaf, 0x27, 0x1c]) // 7z
        || starts(b"Rar!\x1a\x07") // rar
        || starts(&[0x89, b'P', b'N', b'G']) // png
        || starts(&[0xff, 0xd8, 0xff]) // jpeg
        || starts(b"GIF8") // gif
        || (starts(b"RIFF") && d.len() >= 12 && &d[8..12] == b"WEBP") // webp
        || (d.len() >= 12 && &d[4..8] == b"ftyp") // mp4 / mov / heic / avif
        || starts(&[0x1a, 0x45, 0xdf, 0xa3]) // matroska / webm
        || starts(b"OggS") // ogg
        || starts(b"fLaC") // flac
        || starts(b"ID3") // mp3
        || starts(&[0x04, 0x22, 0x4d, 0x18]) // lz4 frame
}

fn hint_is_media(hint: &str) -> bool {
    hint.starts_with("image/")
        || hint.starts_with("video/")
        || hint.starts_with("audio/")
        || matches!(
            hint,
            "application/zip"
                | "application/gzip"
                | "application/x-gzip"
                | "application/zstd"
                | "application/x-7z-compressed"
                | "application/x-rar-compressed"
                | "application/x-xz"
                | "application/x-bzip2"
                | "application/octet-stream+compressed"
        )
}

fn looks_like_text(d: &[u8]) -> bool {
    let printable = d
        .iter()
        .filter(|&&b| b == b'\t' || b == b'\n' || b == b'\r' || (0x20..0x7f).contains(&b) || b >= 0x80)
        .count();
    if (printable as f64) < 0.97 * d.len() as f64 {
        return false;
    }
    match std::str::from_utf8(d) {
        Ok(_) => true,
        // A prefix may cut a multi-byte char; tolerate an incomplete trailing sequence only.
        Err(e) => e.error_len().is_none() && e.valid_up_to() + 4 >= d.len(),
    }
}

fn looks_like_csv(d: &[u8]) -> bool {
    let text = String::from_utf8_lossy(&d[..d.len().min(8192)]);
    let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).take(20).collect();
    if lines.len() < 3 {
        return false;
    }
    for sep in [',', '\t', ';'] {
        let first = lines[0].matches(sep).count();
        if first >= 1 && lines[..lines.len() - 1].iter().all(|l| l.matches(sep).count() == first) {
            return true;
        }
    }
    false
}

/// True when some byte lane at stride 2/4/8 is much more predictable than the whole stream —
/// the signature of fixed-width numeric records (f32/f64/int arrays).
fn looks_numeric(d: &[u8]) -> bool {
    if d.len() < 1024 {
        return false;
    }
    let whole = DiocomNativeReactor::calculate_entropy(d);
    for stride in [4usize, 8, 2] {
        let mut min_lane = f64::MAX;
        for lane in 0..stride {
            let bytes: Vec<u8> = d.iter().skip(lane).step_by(stride).copied().collect();
            min_lane = min_lane.min(DiocomNativeReactor::calculate_entropy(&bytes));
        }
        if whole >= 4.0 && min_lane <= whole - 2.0 {
            return true;
        }
    }
    false
}

/// Classifies an upload. `mime_hint` is the optional `x-content-type` header.
pub fn classify(data: &[u8], mime_hint: Option<&str>) -> &'static str {
    if data.is_empty() {
        return EMPTY;
    }
    let hint = mime_hint
        .map(|h| h.split(';').next().unwrap_or("").trim().to_ascii_lowercase())
        .unwrap_or_default();
    let prefix = &data[..data.len().min(SNIFF_BYTES)];

    if has_compressed_magic(prefix) {
        return MEDIA_COMPRESSED;
    }
    if looks_like_text(prefix) {
        let first = prefix.iter().copied().find(|b| !b.is_ascii_whitespace()).unwrap_or(b' ');
        if hint.contains("json") || first == b'{' || first == b'[' {
            return TEXT_JSON;
        }
        if hint.contains("xml") || hint.contains("html") || hint.contains("svg") || first == b'<' {
            return TEXT_MARKUP;
        }
        if hint.contains("csv") || hint.contains("tab-separated") || looks_like_csv(prefix) {
            return TEXT_CSV;
        }
        return TEXT_PLAIN;
    }
    if looks_numeric(prefix) {
        return BINARY_NUMERIC;
    }
    let entropy = DiocomNativeReactor::calculate_entropy(prefix);
    if entropy >= HIGH_ENTROPY || (hint_is_media(&hint) && entropy >= 7.0) {
        return MEDIA_COMPRESSED;
    }
    BINARY_STRUCTURED
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(n: usize, seed: u64) -> Vec<u8> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                (s >> 33) as u8
            })
            .collect()
    }

    #[test]
    fn classes() {
        assert_eq!(classify(b"", None), EMPTY);
        assert_eq!(classify(b"{\"a\": 1, \"b\": [1,2,3]}", None), TEXT_JSON);
        assert_eq!(classify(b"  [1,2]", None), TEXT_JSON);
        assert_eq!(classify(b"key=value", Some("application/json; charset=utf-8")), TEXT_JSON);
        assert_eq!(classify(b"<html><body>hi</body></html>", None), TEXT_MARKUP);
        assert_eq!(classify(b"a,b,c\n1,2,3\n4,5,6\n7,8,9\n", None), TEXT_CSV);
        assert_eq!(classify("hello world, plain text h\u{e9}r\u{e9}\n".as_bytes(), None), TEXT_PLAIN);
        assert_eq!(classify(&lcg(100_000, 1), None), MEDIA_COMPRESSED);
        let mut gz = vec![0x1f, 0x8b];
        gz.extend_from_slice(b"hello");
        assert_eq!(classify(&gz, None), MEDIA_COMPRESSED);
        let floats: Vec<u8> = (0..20_000)
            .flat_map(|i| (20.0f32 + (i as f32 * 0.01).sin() * 3.0).to_le_bytes())
            .collect();
        assert_eq!(classify(&floats, None), BINARY_NUMERIC);
        let mut structured = Vec::new();
        for i in 0..2000u32 {
            structured.extend_from_slice(b"\x00\x01REC");
            structured.extend_from_slice(format!("{:05}", i % 97).as_bytes());
            structured.push((i % 3) as u8);
        }
        let c = classify(&structured, None);
        assert!(c == BINARY_STRUCTURED || c == BINARY_NUMERIC, "{}", c);
        for c in CLASSES {
            assert_eq!(canonical(c), Some(c));
        }
        assert!(!is_evolvable(MEDIA_COMPRESSED) && !is_evolvable(EMPTY) && is_evolvable(TEXT_JSON));
    }
}
