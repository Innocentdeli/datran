//! Blob format v2 (`FLAG_RECIPE = 0x10`): header, filters, codecs and the strict decoder.
//! See `docs/EVOLUTION_SPEC.md` §1. This module is the byte-format contract shared with the
//! TypeScript decoder.

use crate::reactor::DiocomNativeReactor;
use flate2::bufread::ZlibDecoder;
use flate2::write::ZlibEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::sync::Arc;

pub const FLAG_RECIPE: u8 = 0x10;
pub const FORMAT_VERSION: u8 = 1;
pub const HEADER_LEN: usize = 49;
pub const NO_DICT: [u8; 32] = [0u8; 32];

/// LZ4 block format can never expand more than ~255x.
const LZ4_MAX_RATIO: usize = 255;

pub type DictId = [u8; 32];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Codec {
    Raw,
    Lz4,
    Deflate,
    Zstd,
    Brotli,
    /// Program of FILL/REPEAT/ARITH ops + zstd literals (`docs/NETWORK_SPEC.md` §1).
    Procedural,
}

impl Codec {
    pub const ALL: [Codec; 6] =
        [Codec::Raw, Codec::Lz4, Codec::Deflate, Codec::Zstd, Codec::Brotli, Codec::Procedural];

    pub fn id(self) -> u8 {
        match self {
            Codec::Raw => 0,
            Codec::Lz4 => 1,
            Codec::Deflate => 2,
            Codec::Zstd => 3,
            Codec::Brotli => 4,
            Codec::Procedural => 5,
        }
    }

    pub fn from_id(id: u8) -> Option<Codec> {
        Codec::ALL.get(id as usize).copied()
    }

    pub fn name(self) -> &'static str {
        match self {
            Codec::Raw => "raw",
            Codec::Lz4 => "lz4",
            Codec::Deflate => "deflate",
            Codec::Zstd => "zstd",
            Codec::Brotli => "brotli",
            Codec::Procedural => "procedural",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Filter {
    None,
    Delta,
    Shuffle,
}

impl Filter {
    pub const ALL: [Filter; 3] = [Filter::None, Filter::Delta, Filter::Shuffle];

    pub fn id(self) -> u8 {
        match self {
            Filter::None => 0,
            Filter::Delta => 1,
            Filter::Shuffle => 2,
        }
    }

    pub fn from_id(id: u8) -> Option<Filter> {
        Filter::ALL.get(id as usize).copied()
    }
}

pub const STRIDES: [u8; 4] = [1, 2, 4, 8];

/// Checks the filter/stride pairing rule shared by blobs and recipes.
pub fn valid_filter_stride(filter: Filter, stride: u8) -> bool {
    match filter {
        Filter::None => stride == 0,
        _ => STRIDES.contains(&stride),
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecodeError {
    /// Malformed or corrupt blob.
    Invalid(String),
    /// The blob references a dictionary this node does not have.
    UnknownDict(DictId),
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::Invalid(m) => write!(f, "{}", m),
            DecodeError::UnknownDict(id) => write!(f, "unknown dictionary {}", hex::encode(id)),
        }
    }
}

impl std::error::Error for DecodeError {}

fn invalid(msg: impl Into<String>) -> DecodeError {
    DecodeError::Invalid(msg.into())
}

pub fn sha256(data: &[u8]) -> DictId {
    Sha256::digest(data).into()
}

pub fn crc32(data: &[u8]) -> u32 {
    crc32fast::hash(data)
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

pub fn apply_filter(filter: Filter, stride: u8, data: &[u8]) -> Vec<u8> {
    let s = stride as usize;
    match filter {
        Filter::None => data.to_vec(),
        Filter::Delta => {
            let mut out = Vec::with_capacity(data.len());
            for (i, &b) in data.iter().enumerate() {
                if i < s {
                    out.push(b);
                } else {
                    out.push(b.wrapping_sub(data[i - s]));
                }
            }
            out
        }
        Filter::Shuffle => {
            let n = data.len();
            let m = n / s;
            let mut out = vec![0u8; n];
            for b in 0..s {
                let base = b * m;
                for e in 0..m {
                    out[base + e] = data[e * s + b];
                }
            }
            out[m * s..].copy_from_slice(&data[m * s..]);
            out
        }
    }
}

pub fn unapply_filter(filter: Filter, stride: u8, mut data: Vec<u8>) -> Vec<u8> {
    let s = stride as usize;
    match filter {
        Filter::None => data,
        Filter::Delta => {
            for i in s..data.len() {
                data[i] = data[i].wrapping_add(data[i - s]);
            }
            data
        }
        Filter::Shuffle => {
            let n = data.len();
            let m = n / s;
            let mut out = vec![0u8; n];
            for b in 0..s {
                let base = b * m;
                for e in 0..m {
                    out[e * s + b] = data[base + e];
                }
            }
            out[m * s..].copy_from_slice(&data[m * s..]);
            out
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------------------------

/// Low-level encode parameters (already validated by `Recipe`).
#[derive(Debug, Clone, Copy)]
pub struct EncodeParams<'a> {
    pub codec: Codec,
    pub level: i32,
    pub window_log: Option<u32>,
    pub filter: Filter,
    pub stride: u8,
    /// (id, bytes); zstd only.
    pub dict: Option<(&'a DictId, &'a [u8])>,
}

pub fn encode(p: &EncodeParams, data: &[u8]) -> Result<Vec<u8>, String> {
    encode_with_workers(p, data, 0)
}

/// [`encode`] with zstd's built-in multithreading: `workers` > 1 sets `ZSTD_c_nbWorkers` for the
/// zstd codec (other codecs ignore it). The output is still one standard zstd frame (with the
/// content size), so the blob format and every decoder are unchanged; only the exact compressed
/// bytes may differ from a single-threaded encode. Evolution scoring always uses [`encode`].
pub fn encode_with_workers(p: &EncodeParams, data: &[u8], workers: u32) -> Result<Vec<u8>, String> {
    if !valid_filter_stride(p.filter, p.stride) {
        return Err(format!("invalid filter/stride {:?}/{}", p.filter, p.stride));
    }
    if p.dict.is_some() && p.codec != Codec::Zstd {
        return Err("dictionary is only allowed with zstd".into());
    }
    let filtered;
    let input: &[u8] = if p.filter == Filter::None {
        data
    } else {
        filtered = apply_filter(p.filter, p.stride, data);
        &filtered
    };

    let mut out = Vec::with_capacity(HEADER_LEN + data.len() / 2 + 64);
    out.push(FLAG_RECIPE);
    out.push(FORMAT_VERSION);
    out.push(p.codec.id());
    out.push(p.filter.id());
    out.push(p.stride);
    out.extend_from_slice(&(data.len() as u64).to_le_bytes());
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(p.dict.map(|(id, _)| id).unwrap_or(&NO_DICT));
    debug_assert_eq!(out.len(), HEADER_LEN);

    match p.codec {
        Codec::Raw => out.extend_from_slice(input),
        Codec::Lz4 => out.extend_from_slice(&lz4_flex::block::compress(input)),
        Codec::Deflate => {
            let level = p.level.clamp(0, 9) as u32;
            let mut enc = ZlibEncoder::new(out, Compression::new(level));
            enc.write_all(input).map_err(|e| e.to_string())?;
            out = enc.finish().map_err(|e| e.to_string())?;
        }
        Codec::Zstd => {
            let dict_bytes: &[u8] = p.dict.map(|(_, d)| d).unwrap_or(&[]);
            let mut c = zstd::bulk::Compressor::with_dictionary(p.level, dict_bytes)
                .map_err(|e| format!("zstd init: {}", e))?;
            if let Some(w) = p.window_log {
                c.set_parameter(zstd::stream::raw::CParameter::WindowLog(w))
                    .map_err(|e| format!("zstd window_log: {}", e))?;
            }
            if workers > 1 {
                // a library built without ZSTD_MULTITHREAD rejects this: stay single-threaded
                let _ = c.set_parameter(zstd::stream::raw::CParameter::NbWorkers(workers));
            }
            let compressed = c.compress(input).map_err(|e| format!("zstd: {}", e))?;
            out.extend_from_slice(&compressed);
        }
        Codec::Brotli => {
            let params = brotli::enc::BrotliEncoderParams {
                quality: p.level,
                lgwin: p.window_log.map(|w| w as i32).unwrap_or(22),
                size_hint: input.len(),
                ..Default::default()
            };
            let mut reader = input;
            brotli::BrotliCompress(&mut reader, &mut out, &params)
                .map_err(|e| format!("brotli: {}", e))?;
        }
        Codec::Procedural => out.extend_from_slice(&crate::procedural::encode(input, p.level)?),
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Decode
// ---------------------------------------------------------------------------------------------

/// Parsed v2 header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub codec: Codec,
    pub filter: Filter,
    pub stride: u8,
    pub original_len: u64,
    pub crc: u32,
    pub dict: Option<DictId>,
}

pub fn parse_header(blob: &[u8], limit: usize) -> Result<Header, DecodeError> {
    if blob.len() < HEADER_LEN {
        return Err(invalid(format!("v2 blob too short: {} bytes", blob.len())));
    }
    if blob[0] != FLAG_RECIPE {
        return Err(invalid(format!("not a v2 blob (flag 0x{:02x})", blob[0])));
    }
    if blob[1] != FORMAT_VERSION {
        return Err(invalid(format!("unknown v2 format version {}", blob[1])));
    }
    let codec = Codec::from_id(blob[2]).ok_or_else(|| invalid(format!("unknown codec {}", blob[2])))?;
    let filter =
        Filter::from_id(blob[3]).ok_or_else(|| invalid(format!("unknown filter {}", blob[3])))?;
    let stride = blob[4];
    if !valid_filter_stride(filter, stride) {
        return Err(invalid(format!("invalid stride {} for filter {:?}", stride, filter)));
    }
    let mut len8 = [0u8; 8];
    len8.copy_from_slice(&blob[5..13]);
    let original_len = u64::from_le_bytes(len8);
    if original_len > limit as u64 {
        return Err(invalid(format!(
            "original length {} exceeds output limit of {} bytes",
            original_len, limit
        )));
    }
    let crc = u32::from_le_bytes([blob[13], blob[14], blob[15], blob[16]]);
    let mut id = [0u8; 32];
    id.copy_from_slice(&blob[17..49]);
    let dict = if id == NO_DICT { None } else { Some(id) };
    if dict.is_some() && codec != Codec::Zstd {
        return Err(invalid(format!("dictionary set on non-zstd codec {}", codec.name())));
    }
    Ok(Header { codec, filter, stride, original_len, crc, dict })
}

fn read_capped<R: Read>(reader: &mut R, expected: usize, what: &str) -> Result<Vec<u8>, DecodeError> {
    let mut out = Vec::with_capacity(expected.min(16 << 20));
    reader
        .take(expected as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| invalid(format!("{} decode failed: {}", what, e)))?;
    Ok(out)
}

fn no_trailing(rest: &[u8], what: &str) -> Result<(), DecodeError> {
    if rest.is_empty() {
        Ok(())
    } else {
        Err(invalid(format!("{} stream followed by {} trailing bytes", what, rest.len())))
    }
}

/// Brotli via the low-level stream API so we know exactly how much input the stream used.
fn brotli_decode(payload: &[u8], expected: usize) -> Result<Vec<u8>, DecodeError> {
    use brotli::enc::StandardAlloc;
    use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};
    let mut state = BrotliState::new(StandardAlloc::default(), StandardAlloc::default(), StandardAlloc::default());
    let mut out = Vec::with_capacity(expected.min(16 << 20));
    let mut buf = vec![0u8; 64 * 1024];
    let (mut avail_in, mut in_off, mut total) = (payload.len(), 0usize, 0usize);
    loop {
        let (mut avail_out, mut out_off) = (buf.len(), 0usize);
        let r = BrotliDecompressStream(
            &mut avail_in,
            &mut in_off,
            payload,
            &mut avail_out,
            &mut out_off,
            &mut buf,
            &mut total,
            &mut state,
        );
        out.extend_from_slice(&buf[..out_off]);
        if out.len() > expected {
            return Err(invalid("brotli output exceeds original length"));
        }
        match r {
            BrotliResult::ResultSuccess => break,
            BrotliResult::NeedsMoreOutput => continue,
            BrotliResult::NeedsMoreInput => return Err(invalid("brotli stream truncated")),
            BrotliResult::ResultFailure => return Err(invalid("brotli decode failed")),
        }
    }
    no_trailing(&payload[in_off.min(payload.len())..], "brotli")?;
    Ok(out)
}

/// Decode a v2 blob. `dict_lookup` resolves dictionary ids (returning `None` makes the decode fail
/// with `DecodeError::UnknownDict`). Never panics on malformed input.
pub fn decode_v2(
    blob: &[u8],
    limit: usize,
    dict_lookup: &dyn Fn(&DictId) -> Option<Arc<Vec<u8>>>,
) -> Result<Vec<u8>, DecodeError> {
    let h = parse_header(blob, limit)?;
    let n = h.original_len as usize;
    let payload = &blob[HEADER_LEN..];

    let decoded = match h.codec {
        Codec::Raw => {
            if payload.len() != n {
                return Err(invalid(format!(
                    "raw payload length {} != original length {}",
                    payload.len(),
                    n
                )));
            }
            payload.to_vec()
        }
        Codec::Lz4 => {
            if n > payload.len().saturating_mul(LZ4_MAX_RATIO).saturating_add(16) {
                return Err(invalid("lz4 original length impossible for payload length"));
            }
            let mut buf = vec![0u8; n];
            let written = lz4_flex::block::decompress_into(payload, &mut buf)
                .map_err(|e| invalid(format!("lz4 decode failed: {}", e)))?;
            buf.truncate(written);
            buf
        }
        Codec::Deflate => {
            let mut dec = ZlibDecoder::new(payload);
            let out = read_capped(&mut dec, n, "deflate")?;
            if out.len() == n {
                // make sure the stream (incl. Adler-32 trailer) really ended, then check for trailing bytes
                let mut probe = [0u8; 1];
                if dec.read(&mut probe).map_err(|e| invalid(format!("deflate decode failed: {}", e)))? != 0 {
                    return Err(invalid("deflate output exceeds original length"));
                }
                no_trailing(dec.into_inner(), "deflate")?;
            }
            out
        }
        Codec::Zstd => {
            let dict = match &h.dict {
                Some(id) => Some(dict_lookup(id).ok_or(DecodeError::UnknownDict(*id))?),
                None => None,
            };
            let dict_bytes: &[u8] = dict.as_deref().map(|d| d.as_slice()).unwrap_or(&[]);
            let mut dec = zstd::stream::read::Decoder::with_dictionary(payload, dict_bytes)
                .map_err(|e| invalid(format!("zstd init failed: {}", e)))?
                .single_frame();
            let out = read_capped(&mut dec, n, "zstd")?;
            if out.len() == n {
                dec.finish_frame().map_err(|e| invalid(format!("zstd decode failed: {}", e)))?;
                no_trailing(dec.into_inner(), "zstd")?;
            }
            out
        }
        Codec::Brotli => brotli_decode(payload, n)?,
        Codec::Procedural => crate::procedural::decode(payload, n).map_err(DecodeError::Invalid)?,
    };

    if decoded.len() != n {
        return Err(invalid(format!(
            "decoded length {} != original length {}",
            decoded.len(),
            n
        )));
    }
    let out = unapply_filter(h.filter, h.stride, decoded);
    let crc = crc32(&out);
    if crc != h.crc {
        return Err(invalid(format!("CRC mismatch: header {:08x}, data {:08x}", h.crc, crc)));
    }
    Ok(out)
}

/// Checks that `blob` (v2) decodes to exactly `data` — the round-trip check of an encode.
///
/// Unfiltered zstd blobs are decoded as a stream in 1 MiB slices that are compared with `data`
/// as they come out (no output allocation of the full size, no CRC pass: the byte comparison is
/// strictly stronger); everything else goes through [`decode_v2`] + comparison. The frame must
/// end exactly at the end of the blob either way.
pub fn verify_v2(blob: &[u8], data: &[u8], dict_lookup: &dyn Fn(&DictId) -> Option<Arc<Vec<u8>>>) -> Result<(), DecodeError> {
    let h = parse_header(blob, usize::MAX)?;
    if h.original_len != data.len() as u64 {
        return Err(invalid(format!("header length {} != input length {}", h.original_len, data.len())));
    }
    if h.codec != Codec::Zstd || h.filter != Filter::None {
        return match decode_v2(blob, data.len(), dict_lookup)? {
            out if out.as_slice() == data => Ok(()),
            _ => Err(invalid("round-trip mismatch")),
        };
    }
    let dict = match &h.dict {
        Some(id) => Some(dict_lookup(id).ok_or(DecodeError::UnknownDict(*id))?),
        None => None,
    };
    let dict_bytes: &[u8] = dict.as_deref().map(|d| d.as_slice()).unwrap_or(&[]);
    let mut dec = zstd::stream::read::Decoder::with_dictionary(&blob[HEADER_LEN..], dict_bytes)
        .map_err(|e| invalid(format!("zstd init failed: {}", e)))?
        .single_frame();
    let mut buf = vec![0u8; (1 << 20).min(data.len().max(1))];
    let mut pos = 0usize;
    loop {
        let n = dec.read(&mut buf).map_err(|e| invalid(format!("zstd decode failed: {}", e)))?;
        if n == 0 {
            break;
        }
        if pos + n > data.len() || buf[..n] != data[pos..pos + n] {
            return Err(invalid("round-trip mismatch"));
        }
        pos += n;
    }
    if pos != data.len() {
        return Err(invalid(format!("decoded length {} != original length {}", pos, data.len())));
    }
    dec.finish_frame().map_err(|e| invalid(format!("zstd decode failed: {}", e)))?;
    no_trailing(dec.into_inner(), "zstd")
}

/// Blocking `Read` over compressed segments sent by the encoder thread.
struct SegmentReader {
    rx: std::sync::mpsc::Receiver<Vec<u8>>,
    cur: Vec<u8>,
    pos: usize,
}

impl Read for SegmentReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.cur.len() {
            match self.rx.recv() {
                Ok(v) => {
                    self.cur = v;
                    self.pos = 0;
                }
                Err(_) => return Ok(0),
            }
        }
        let n = buf.len().min(self.cur.len() - self.pos);
        buf[..n].copy_from_slice(&self.cur[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Appends everything to `out` and sends a copy of each segment to the verifier.
struct Tee<'a> {
    out: &'a mut Vec<u8>,
    tx: Option<std::sync::mpsc::SyncSender<Vec<u8>>>,
}

impl Write for Tee<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.out.extend_from_slice(buf);
        if let Some(tx) = &self.tx {
            if tx.send(buf.to_vec()).is_err() {
                // the verifier already failed; its error is reported by the caller
                self.tx = None;
            }
        }
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Multithreaded zstd encode of unfiltered `data` with the round-trip check running
/// **concurrently**: the frame is produced with zstd's streaming MT encoder and every compressed
/// segment is handed to a decoder thread that compares the decoded bytes with `data` as they come
/// out. Returns the v2 blob only if the whole frame decoded to exactly `data` and ended exactly at
/// the end of the output (same guarantee as encode + [`verify_v2`], wall time ≈ the slower of the
/// two instead of their sum). The frame is one standard zstd frame with the content size, like
/// [`encode_with_workers`].
pub fn encode_zstd_mt_verified(level: i32, window_log: Option<u32>, dict: Option<(&DictId, &[u8])>, data: &[u8], workers: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(HEADER_LEN + data.len() / 3 + 64);
    out.push(FLAG_RECIPE);
    out.push(FORMAT_VERSION);
    out.push(Codec::Zstd.id());
    out.push(Filter::None.id());
    out.push(0);
    out.extend_from_slice(&(data.len() as u64).to_le_bytes());
    out.extend_from_slice(&crc32(data).to_le_bytes());
    out.extend_from_slice(dict.map(|(id, _)| id).unwrap_or(&NO_DICT));
    let dict_bytes: &[u8] = dict.map(|(_, d)| d).unwrap_or(&[]);
    let (tx, rx) = std::sync::mpsc::sync_channel::<Vec<u8>>(256);
    std::thread::scope(|s| {
        let verifier = s.spawn(move || -> Result<(), String> {
            let reader = std::io::BufReader::with_capacity(1 << 16, SegmentReader { rx, cur: Vec::new(), pos: 0 });
            let mut dec = zstd::stream::read::Decoder::with_dictionary(reader, dict_bytes).map_err(|e| format!("zstd init: {}", e))?.single_frame();
            let mut buf = vec![0u8; 1 << 20];
            let mut pos = 0usize;
            loop {
                let n = dec.read(&mut buf).map_err(|e| format!("round-trip failed: zstd decode: {}", e))?;
                if n == 0 {
                    break;
                }
                if pos + n > data.len() || buf[..n] != data[pos..pos + n] {
                    return Err("round-trip mismatch".into());
                }
                pos += n;
            }
            if pos != data.len() {
                return Err(format!("round-trip failed: decoded {} of {} bytes", pos, data.len()));
            }
            dec.finish_frame().map_err(|e| format!("round-trip failed: {}", e))?;
            let mut rest = dec.finish();
            let mut probe = [0u8; 1];
            if rest.read(&mut probe).map_err(|e| e.to_string())? != 0 {
                return Err("round-trip failed: bytes after the zstd frame".into());
            }
            Ok(())
        });
        let encoded = (|| -> std::io::Result<()> {
            let tee = Tee { out: &mut out, tx: Some(tx) };
            let mut enc = zstd::stream::write::Encoder::with_dictionary(tee, level, dict_bytes)?;
            enc.include_contentsize(true)?;
            enc.set_pledged_src_size(Some(data.len() as u64))?;
            if let Some(w) = window_log {
                enc.window_log(w)?;
            }
            if workers > 1 {
                // a library built without ZSTD_MULTITHREAD rejects this: stay single-threaded
                let _ = enc.multithread(workers);
            }
            // feed in slices so the first compressed segments reach the verifier early
            for part in data.chunks(4 << 20) {
                enc.write_all(part)?;
            }
            let tee = enc.finish()?;
            drop(tee); // closes the channel: the verifier sees the end of the stream
            Ok(())
        })();
        let verified = verifier.join().map_err(|_| "verifier panicked".to_string())?;
        encoded.map_err(|e| format!("zstd: {}", e))?;
        verified
    })?;
    Ok(out)
}

/// Decode any reactor blob: legacy flags 0x00–0x03 and v2 (0x10).
pub fn decode_any(
    blob: &[u8],
    limit: usize,
    dict_lookup: &dyn Fn(&DictId) -> Option<Arc<Vec<u8>>>,
) -> Result<Vec<u8>, DecodeError> {
    match blob.first() {
        Some(&FLAG_RECIPE) => decode_v2(blob, limit, dict_lookup),
        _ => DiocomNativeReactor::decompress_with_limit(blob, limit).map_err(DecodeError::Invalid),
    }
}

/// Legacy raw blob (`0x02` + data).
pub fn legacy_raw(data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(data.len() + 1);
    v.push(crate::reactor::FLAG_RAW);
    v.extend_from_slice(data);
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_dict(_: &DictId) -> Option<Arc<Vec<u8>>> {
        None
    }

    #[test]
    fn filters_invert_for_all_strides_and_lengths() {
        for n in [0usize, 1, 2, 3, 7, 8, 9, 15, 16, 17, 1000, 1003] {
            let data: Vec<u8> = (0..n).map(|i| (i * 7 + i / 3) as u8).collect();
            for f in [Filter::Delta, Filter::Shuffle] {
                for s in STRIDES {
                    let enc = apply_filter(f, s, &data);
                    assert_eq!(enc.len(), n);
                    assert_eq!(unapply_filter(f, s, enc), data, "{:?} s{} n{}", f, s, n);
                }
            }
        }
    }

    #[test]
    fn filter_definitions_match_spec() {
        let d = [10u8, 20, 5, 1, 7];
        assert_eq!(apply_filter(Filter::Delta, 2, &d), vec![10, 20, 251, 237, 2]);
        // m = 5/2 = 2: plane0 = in[0], in[2]; plane1 = in[1], in[3]; tail in[4]
        assert_eq!(apply_filter(Filter::Shuffle, 2, &d), vec![10, 5, 20, 1, 7]);
    }

    #[test]
    fn header_layout() {
        let p = EncodeParams {
            codec: Codec::Raw,
            level: 0,
            window_log: None,
            filter: Filter::None,
            stride: 0,
            dict: None,
        };
        let b = encode(&p, b"abc").unwrap();
        assert_eq!(b.len(), HEADER_LEN + 3);
        assert_eq!(&b[..5], &[0x10, 1, 0, 0, 0]);
        assert_eq!(&b[5..13], &3u64.to_le_bytes());
        assert_eq!(&b[13..17], &crc32(b"abc").to_le_bytes());
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
        assert_eq!(&b[17..49], &NO_DICT);
        assert_eq!(decode_v2(&b, 100, &no_dict).unwrap(), b"abc");
        assert!(decode_any(&b, 100, &no_dict).is_ok());
    }
}
