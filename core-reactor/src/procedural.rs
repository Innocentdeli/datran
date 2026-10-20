//! Procedural codec (blob v2 codec id `5`), see `docs/NETWORK_SPEC.md` §1.
//!
//! Payload = `varint program_len | program | literal_stream`, where the program is a list of ops
//! (LITERAL / FILL / REPEAT / ARITH) and the literal stream is one zstd frame holding the
//! concatenated literal bytes (empty when there are none). Ops apply to the *filtered* bytes.
//!
//! The decoder validates the whole program before producing any output, so a malformed or
//! lying payload is rejected without allocating the declared output; it never panics.
//! The encoder is a single, roughly linear-time pass (see [`encode`]).

use std::io::Read;

pub const OP_LITERAL: u8 = 0x01;
pub const OP_FILL: u8 = 0x02;
pub const OP_REPEAT: u8 = 0x03;
pub const OP_ARITH: u8 = 0x04;

/// Largest REPEAT period the decoder accepts.
pub const MAX_REPEAT_PERIOD: u64 = 16 << 20;
/// Largest REPEAT period the encoder searches for.
pub const ENC_MAX_PERIOD: usize = 64 * 1024;
/// Encoder thresholds (spec §1).
pub const MIN_FILL: usize = 32;
pub const MIN_ARITH_ELEMS: usize = 16;
pub const MIN_REPEAT_BYTES: usize = 64;
/// A REPEAT must cover ≥ 4 periods counting its source period, i.e. copy ≥ 3 periods.
pub const MIN_REPEAT_PERIODS: usize = 4;

const ARITH_WIDTHS: [usize; 4] = [1, 2, 4, 8];

// ---------------------------------------------------------------------------------------------
// Varints (LEB128, u64, at most 10 bytes)
// ---------------------------------------------------------------------------------------------

pub fn write_varint(out: &mut Vec<u8>, mut v: u64) {
    while v >= 0x80 {
        out.push((v as u8) | 0x80);
        v >>= 7;
    }
    out.push(v as u8);
}

pub fn read_varint(buf: &[u8], pos: &mut usize) -> Result<u64, String> {
    let mut v = 0u64;
    for i in 0..10 {
        let Some(&b) = buf.get(*pos) else {
            return Err("procedural: truncated varint".into());
        };
        *pos += 1;
        if i == 9 && b > 1 {
            return Err("procedural: varint overflows u64".into());
        }
        v |= u64::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            return Ok(v);
        }
    }
    Err("procedural: varint overflows u64".into())
}

fn mask(w: usize) -> u64 {
    if w >= 8 {
        u64::MAX
    } else {
        (1u64 << (8 * w)) - 1
    }
}

// ---------------------------------------------------------------------------------------------
// Decoder
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
enum Op {
    Literal(usize),
    Fill(usize, u8),
    Repeat {
        p: usize,
        n: usize,
    },
    Arith {
        w: usize,
        be: bool,
        k: usize,
        start: u64,
        delta: u64,
    },
}

/// Validating op reader: tracks output position against the original length.
struct OpReader<'a> {
    prog: &'a [u8],
    pos: usize,
    out: u64,
    limit: u64,
    literals: u64,
}

impl<'a> OpReader<'a> {
    fn take(&mut self, len: usize) -> Result<&'a [u8], String> {
        let end = self.pos.checked_add(len).filter(|e| *e <= self.prog.len());
        let Some(end) = end else {
            return Err("procedural: truncated op".into());
        };
        let s = &self.prog[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    fn advance(&mut self, len: u64, what: &str) -> Result<usize, String> {
        if len > self.limit - self.out {
            return Err(format!(
                "procedural: {} op exceeds the original length",
                what
            ));
        }
        self.out += len;
        Ok(len as usize)
    }

    fn next_op(&mut self) -> Option<Result<Op, String>> {
        if self.pos >= self.prog.len() {
            return None;
        }
        let code = self.prog[self.pos];
        self.pos += 1;
        Some(self.parse(code))
    }

    fn parse(&mut self, code: u8) -> Result<Op, String> {
        match code {
            OP_LITERAL => {
                let n = read_varint(self.prog, &mut self.pos)?;
                let n = self.advance(n, "LITERAL")?;
                self.literals += n as u64;
                Ok(Op::Literal(n))
            }
            OP_FILL => {
                let n = read_varint(self.prog, &mut self.pos)?;
                let v = self.take(1)?[0];
                let n = self.advance(n, "FILL")?;
                Ok(Op::Fill(n, v))
            }
            OP_REPEAT => {
                let p = read_varint(self.prog, &mut self.pos)?;
                let n = read_varint(self.prog, &mut self.pos)?;
                if p == 0 || p > self.out || p > MAX_REPEAT_PERIOD {
                    return Err(format!(
                        "procedural: invalid REPEAT period {} at output position {}",
                        p, self.out
                    ));
                }
                let n = self.advance(n, "REPEAT")?;
                Ok(Op::Repeat { p: p as usize, n })
            }
            OP_ARITH => {
                let we = self.take(2)?;
                let (w, endian) = (we[0] as usize, we[1]);
                if !ARITH_WIDTHS.contains(&w) {
                    return Err(format!("procedural: invalid ARITH width {}", w));
                }
                if endian > 1 {
                    return Err(format!("procedural: invalid ARITH endian {}", endian));
                }
                let k = read_varint(self.prog, &mut self.pos)?;
                let bytes = k
                    .checked_mul(w as u64)
                    .ok_or("procedural: ARITH length overflows")?;
                let le = |s: &[u8]| {
                    s.iter()
                        .rev()
                        .fold(0u64, |acc, &b| (acc << 8) | u64::from(b))
                };
                let start = le(self.take(w)?);
                let delta = le(self.take(w)?);
                self.advance(bytes, "ARITH")?;
                Ok(Op::Arith {
                    w,
                    be: endian == 1,
                    k: k as usize,
                    start,
                    delta,
                })
            }
            other => Err(format!("procedural: unknown op 0x{:02x}", other)),
        }
    }
}

fn reader(prog: &[u8], limit: u64) -> OpReader<'_> {
    OpReader {
        prog,
        pos: 0,
        out: 0,
        limit,
        literals: 0,
    }
}

fn decode_literals(stream: &[u8], expected: u64) -> Result<Vec<u8>, String> {
    if expected == 0 {
        if !stream.is_empty() {
            return Err(format!(
                "procedural: literal stream has {} unused bytes",
                stream.len()
            ));
        }
        return Ok(Vec::new());
    }
    if stream.is_empty() {
        return Err("procedural: LITERAL beyond the literal stream (stream empty)".into());
    }
    let expected = expected as usize;
    let mut dec = zstd::stream::read::Decoder::with_buffer(stream)
        .map_err(|e| format!("procedural: zstd init failed: {}", e))?
        .single_frame();
    let mut out = Vec::with_capacity(expected.min(16 << 20));
    (&mut dec)
        .take(expected as u64 + 1)
        .read_to_end(&mut out)
        .map_err(|e| format!("procedural: literal stream decode failed: {}", e))?;
    if out.len() < expected {
        return Err(format!(
            "procedural: LITERAL beyond the literal stream ({} of {} bytes)",
            out.len(),
            expected
        ));
    }
    if out.len() > expected {
        return Err("procedural: literal stream has unused trailing bytes".into());
    }
    dec.finish_frame()
        .map_err(|e| format!("procedural: literal stream decode failed: {}", e))?;
    let rest = dec.into_inner();
    if !rest.is_empty() {
        return Err(format!(
            "procedural: {} trailing bytes after the literal stream",
            rest.len()
        ));
    }
    Ok(out)
}

fn write_arith(out: &mut Vec<u8>, w: usize, be: bool, k: usize, start: u64, delta: u64) {
    let m = mask(w);
    let mut v = start;
    macro_rules! gen {
        ($t:ty, $f:ident) => {
            for _ in 0..k {
                out.extend_from_slice(&(v as $t).$f());
                v = v.wrapping_add(delta) & m;
            }
        };
    }
    match (w, be) {
        (1, _) => gen!(u8, to_le_bytes),
        (2, false) => gen!(u16, to_le_bytes),
        (2, true) => gen!(u16, to_be_bytes),
        (4, false) => gen!(u32, to_le_bytes),
        (4, true) => gen!(u32, to_be_bytes),
        (8, false) => gen!(u64, to_le_bytes),
        _ => gen!(u64, to_be_bytes),
    }
}

/// Decodes a procedural payload into exactly `original_len` (filtered) bytes.
pub fn decode(payload: &[u8], original_len: usize) -> Result<Vec<u8>, String> {
    let mut pos = 0;
    let prog_len = read_varint(payload, &mut pos)?;
    if prog_len > (payload.len() - pos) as u64 {
        return Err(format!(
            "procedural: program length {} beyond payload",
            prog_len
        ));
    }
    let prog = &payload[pos..pos + prog_len as usize];
    let stream = &payload[pos + prog_len as usize..];
    let limit = original_len as u64;

    // Pass 1: validate every op, total output and literal count before allocating.
    let mut r = reader(prog, limit);
    while let Some(op) = r.next_op() {
        op?;
    }
    if r.out != limit {
        return Err(format!(
            "procedural: program produces {} bytes, original length is {}",
            r.out, limit
        ));
    }
    let literals = decode_literals(stream, r.literals)?;

    // Pass 2: execute.
    let mut out = Vec::with_capacity(original_len);
    let mut lit_pos = 0usize;
    let mut r = reader(prog, limit);
    while let Some(op) = r.next_op() {
        match op? {
            Op::Literal(n) => {
                out.extend_from_slice(&literals[lit_pos..lit_pos + n]);
                lit_pos += n;
            }
            Op::Fill(n, v) => out.resize(out.len() + n, v),
            Op::Repeat { p, n } => {
                // output[pos] = output[pos - p]: the region from `src` is p-periodic, so copying
                // from a fixed source doubles the available span each step.
                let src = out.len() - p;
                let mut left = n;
                while left > 0 {
                    let c = left.min(out.len() - src);
                    out.extend_from_within(src..src + c);
                    left -= c;
                }
            }
            Op::Arith {
                w,
                be,
                k,
                start,
                delta,
            } => write_arith(&mut out, w, be, k, start, delta),
        }
    }
    debug_assert_eq!(out.len(), original_len);
    Ok(out)
}

/// Lists the program of a payload as `(op code, output bytes, detail)` where detail is the FILL
/// value, the REPEAT period, or the ARITH width (+100 when big-endian); for diagnostics and tests.
/// Validates op structure but not the original length or the literal stream.
pub fn program_summary(payload: &[u8]) -> Result<Vec<(u8, u64, u64)>, String> {
    let mut pos = 0;
    let prog_len = read_varint(payload, &mut pos)?;
    if prog_len > (payload.len() - pos) as u64 {
        return Err("procedural: program length beyond payload".into());
    }
    let mut r = reader(&payload[pos..pos + prog_len as usize], u64::MAX);
    let mut out = Vec::new();
    while let Some(op) = r.next_op() {
        out.push(match op? {
            Op::Literal(n) => (OP_LITERAL, n as u64, 0),
            Op::Fill(n, v) => (OP_FILL, n as u64, u64::from(v)),
            Op::Repeat { p, n } => (OP_REPEAT, n as u64, p as u64),
            Op::Arith { w, be, k, .. } => (
                OP_ARITH,
                (k * w) as u64,
                w as u64 + if be { 100 } else { 0 },
            ),
        });
    }
    Ok(out)
}

// ---------------------------------------------------------------------------------------------
// Encoder
// ---------------------------------------------------------------------------------------------

const HASH_BITS: u32 = 15;

#[inline]
fn load8(x: &[u8], p: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&x[p..p + 8]);
    u64::from_le_bytes(b)
}

#[inline]
fn hash8(v: u64) -> usize {
    (v.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> (64 - HASH_BITS)) as usize
}

/// Length of the common run of `x[a..]` and `x[b..]` (a < b allowed to overlap), at most `max`.
#[inline]
fn match_len(x: &[u8], a: usize, b: usize, max: usize) -> usize {
    let mut t = 0;
    while t + 8 <= max {
        let d = load8(x, a + t) ^ load8(x, b + t);
        if d != 0 {
            return t + (d.trailing_zeros() / 8) as usize;
        }
        t += 8;
    }
    while t < max && x[a + t] == x[b + t] {
        t += 1;
    }
    t
}

#[inline]
fn read_elem(x: &[u8], p: usize, w: usize, be: bool) -> u64 {
    match (w, be) {
        (1, _) => u64::from(x[p]),
        (2, false) => u64::from(u16::from_le_bytes([x[p], x[p + 1]])),
        (2, true) => u64::from(u16::from_be_bytes([x[p], x[p + 1]])),
        (4, false) => u64::from(u32::from_le_bytes([x[p], x[p + 1], x[p + 2], x[p + 3]])),
        (4, true) => u64::from(u32::from_be_bytes([x[p], x[p + 1], x[p + 2], x[p + 3]])),
        (8, false) => load8(x, p),
        _ => load8(x, p).swap_bytes(),
    }
}

/// (width, big-endian) pairs tried for ARITH; width 1 has no endianness.
const ARITH_CANDIDATES: [(usize, bool); 7] = [
    (1, false),
    (2, false),
    (2, true),
    (4, false),
    (4, true),
    (8, false),
    (8, true),
];

/// `x[j], x[j+w], x[j+2w]` have a zero second difference (mod 256).
#[inline]
fn sd0(x: &[u8], j: usize, w: usize) -> bool {
    x[j + 2 * w].wrapping_sub(x[j + w]) == x[j + w].wrapping_sub(x[j])
}

/// Cheap necessary condition for an ARITH run at `i` (caller ensures `i + 16w <= n`): the low byte
/// of `start + j·delta` is `lb(start) + j·lb(delta)` mod 256, so the low bytes (offset 0 for LE,
/// `w - 1` for BE) must themselves be a byte progression at stride `w`. Rejects random data with
/// two byte compares instead of reading whole elements.
#[inline]
fn arith_possible(x: &[u8], i: usize, w: usize, be: bool) -> bool {
    let o = if be { i + w - 1 } else { i };
    sd0(x, o, w) && sd0(x, o + w, w)
}

const LO7: u64 = 0x7f7f_7f7f_7f7f_7f7f;
const HI1: u64 = 0x8080_8080_8080_8080;

/// 0x80 in exactly the zero byte lanes of `v`.
#[inline(always)]
fn zero_lanes(v: u64) -> u64 {
    !(((v & LO7).wrapping_add(LO7)) | v | LO7)
}

/// Lane-wise wrapping `a - b` on 8 bytes.
#[inline(always)]
fn sub_lanes(a: u64, b: u64) -> u64 {
    ((a | HI1).wrapping_sub(b & !HI1)) ^ ((a ^ !b) & HI1)
}

/// Bytes needed after `i` by [`quiet_lanes`].
const QUIET_SPAN: usize = 40;

/// For the 8 positions `i..i+8` (caller ensures `i + 40 <= x.len()`): 0x80 in lane `t` when a FILL
/// or an ARITH run might start at `i + t`, by the necessary conditions `x[j] == x[j+1]` and
/// [`arith_possible`], evaluated for all lanes at once.
#[inline]
fn quiet_lanes(x: &[u8], i: usize) -> u64 {
    let mut a = [0u8; QUIET_SPAN];
    a.copy_from_slice(&x[i..i + QUIET_SPAN]);
    #[inline(always)]
    fn ld(a: &[u8; QUIET_SPAN], o: usize) -> u64 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&a[o..o + 8]);
        u64::from_le_bytes(b)
    }
    let l = |o: usize| ld(&a, o);
    let mut m = zero_lanes(l(0) ^ l(1));
    for w in [1usize, 2, 4, 8] {
        // second difference at stride w is zero for byte lanes starting at offset o
        let sd =
            |o: usize| zero_lanes(sub_lanes(l(o + w), l(o)) ^ sub_lanes(l(o + 2 * w), l(o + w)));
        m |= sd(0) & sd(w);
        if w > 1 {
            m |= sd(w - 1) & sd(2 * w - 1);
        }
    }
    m
}

/// Longest arithmetic run at `i` for one width/endian: `(elements, start, delta)`.
#[inline]
fn arith_run(x: &[u8], i: usize, w: usize, be: bool) -> Option<(usize, u64, u64)> {
    let n = x.len();
    if i + MIN_ARITH_ELEMS * w > n {
        return None;
    }
    let m = mask(w);
    let e0 = read_elem(x, i, w, be);
    let mut prev = read_elem(x, i + w, w, be);
    let d = prev.wrapping_sub(e0) & m;
    let mut k = 2;
    while i + (k + 1) * w <= n {
        let e = read_elem(x, i + k * w, w, be);
        if e.wrapping_sub(prev) & m != d {
            break;
        }
        prev = e;
        k += 1;
    }
    (k >= MIN_ARITH_ELEMS).then_some((k, e0, d))
}

#[derive(Clone, Copy)]
enum Cand {
    Fill(u8),
    Arith {
        w: usize,
        be: bool,
        k: usize,
        start: u64,
        delta: u64,
    },
    /// Period and how many bytes the copy extends *before* the probe position.
    Repeat {
        p: usize,
        back: usize,
    },
}

struct Encoder<'a> {
    x: &'a [u8],
    prog: Vec<u8>,
    lits: Vec<u8>,
    /// hash of 8 bytes -> (low 32 bits of those bytes, position mod 2^32). Compact (256 KiB) so it
    /// stays in cache; every candidate is verified against the data, so a stale or aliased entry
    /// can only cost a compare, never produce a wrong REPEAT.
    table: Box<[(u32, u32); 1 << HASH_BITS]>,
    last_period: usize,
    /// Recently failed (period, end) pairs: the match for that period ends at `end`, so retrying
    /// it before `end` can only find a shorter match. Keeps REPEAT detection amortized linear.
    failed: [(usize, usize); 4],
    failed_next: usize,
    /// Positions below this were shown by [`quiet_lanes`] not to start a FILL/ARITH.
    quiet_until: usize,
}

impl<'a> Encoder<'a> {
    #[inline]
    fn insert(&mut self, p: usize) {
        if p + 8 <= self.x.len() {
            let v = load8(self.x, p);
            self.table[hash8(v)] = (v as u32, p as u32);
        }
    }

    /// REPEAT with period `p` probed at `i`: `(back, fwd)` where the copy starts at `i - back`
    /// (never before `lit_start`, the first pending literal) and ends at `i + fwd`.
    fn try_period(&mut self, i: usize, lit_start: usize, p: usize) -> Option<(usize, usize)> {
        let x = self.x;
        if p == 0 || p > i || p > ENC_MAX_PERIOD {
            return None;
        }
        if self.failed.iter().any(|&(fp, end)| fp == p && i < end) {
            return None;
        }
        let fwd = match_len(x, i - p, i, x.len() - i);
        if fwd < 8 {
            return None;
        }
        // Extend backwards over pending literals (a late hash hit still finds the true start).
        let mut back = 0;
        while i - back > lit_start && i - back > p && x[i - back - 1] == x[i - back - 1 - p] {
            back += 1;
        }
        if back + fwd < MIN_REPEAT_BYTES.max((MIN_REPEAT_PERIODS - 1) * p) {
            self.failed[self.failed_next] = (p, i + fwd);
            self.failed_next = (self.failed_next + 1) % self.failed.len();
            return None;
        }
        Some((back, fwd))
    }

    /// Best op at `i` as (bytes covered from `i`, op); the longest wins, ties in priority order
    /// FILL > ARITH > REPEAT. Also records `i` in the hash table.
    #[inline(always)]
    fn find(&mut self, i: usize, lit_start: usize) -> Option<(usize, Cand)> {
        let x = self.x;
        let n = x.len();
        let mut best: Option<(usize, Cand)> = None;
        // Block prefilter: positions known not to start a FILL/ARITH skip those checks.
        let quiet = i < self.quiet_until
            || (i + QUIET_SPAN <= n && {
                let m = quiet_lanes(x, i);
                self.quiet_until = i + if m == 0 {
                    8
                } else {
                    (m.trailing_zeros() / 8) as usize
                };
                m & 0x80 == 0
            });
        if !quiet && i + MIN_FILL <= n && x[i + 1] == x[i] && x[i + MIN_FILL - 1] == x[i] {
            let len = 1 + match_len(x, i, i + 1, n - i - 1);
            if len >= MIN_FILL {
                best = Some((len, Cand::Fill(x[i])));
            }
        }
        if !quiet && best.is_none() {
            for (w, be) in ARITH_CANDIDATES {
                if i + MIN_ARITH_ELEMS * w > n || !arith_possible(x, i, w, be) {
                    continue;
                }
                if let Some((k, start, delta)) = arith_run(x, i, w, be) {
                    if best.map(|(l, _)| k * w > l).unwrap_or(true) {
                        best = Some((
                            k * w,
                            Cand::Arith {
                                w,
                                be,
                                k,
                                start,
                                delta,
                            },
                        ));
                    }
                }
            }
        }
        if i + 8 <= n {
            let covered = best.map(|(l, _)| l).unwrap_or(0);
            let lp = self.last_period;
            let mut rep = if lp != 0 {
                self.try_period(i, lit_start, lp).map(|(b, f)| (lp, b, f))
            } else {
                None
            };
            let v = load8(x, i);
            let h = hash8(v);
            let (tag, pos) = self.table[h];
            // insert this position (fused with the lookup; positions inside an emitted op are skipped)
            self.table[h] = (v as u32, i as u32);
            if tag == v as u32 {
                let p = (i as u32).wrapping_sub(pos) as usize;
                if p != lp {
                    if let Some((b, f)) = self.try_period(i, lit_start, p) {
                        if rep.map(|(_, _, rf)| f > rf).unwrap_or(true) {
                            rep = Some((p, b, f));
                        }
                    }
                }
            }
            if let Some((p, back, fwd)) = rep {
                if fwd > covered {
                    best = Some((fwd, Cand::Repeat { p, back }));
                }
            }
        }
        best
    }

    fn flush_literal(&mut self, from: usize, to: usize) {
        if to > from {
            self.prog.push(OP_LITERAL);
            write_varint(&mut self.prog, (to - from) as u64);
            self.lits.extend_from_slice(&self.x[from..to]);
        }
    }

    fn emit(&mut self, len: usize, c: Cand) {
        match c {
            Cand::Fill(v) => {
                self.prog.push(OP_FILL);
                write_varint(&mut self.prog, len as u64);
                self.prog.push(v);
            }
            Cand::Arith {
                w,
                be,
                k,
                start,
                delta,
            } => {
                self.prog
                    .extend_from_slice(&[OP_ARITH, w as u8, u8::from(be)]);
                write_varint(&mut self.prog, k as u64);
                self.prog.extend_from_slice(&start.to_le_bytes()[..w]);
                self.prog.extend_from_slice(&delta.to_le_bytes()[..w]);
            }
            Cand::Repeat { p, back } => {
                self.prog.push(OP_REPEAT);
                write_varint(&mut self.prog, p as u64);
                write_varint(&mut self.prog, (back + len) as u64);
                self.last_period = p;
            }
        }
    }
}

/// Encodes `x` (already filtered) as a procedural payload; literals are compressed with zstd at
/// `level`.
///
/// Single greedy pass. At each position the encoder looks for a FILL run (>= 32 bytes), an ARITH
/// run (>= 16 elements; widths 1/2/4/8, both endians) and a REPEAT (period <= 64 KiB, taken from
/// the last used period or a hash of the next 8 bytes, extended backwards over pending literals,
/// copying >= 3 periods - 4 counting the source - and >= 64 bytes); the longest wins, ties in that
/// priority order. Cost stays roughly linear: a SWAR prefilter rules out FILL/ARITH starts for 8
/// positions at a time, REPEAT candidates are tag-checked before any compare, emitted ops are
/// skipped over, and failed long REPEAT probes are remembered so they are not rescanned.
pub fn encode(x: &[u8], level: i32) -> Result<Vec<u8>, String> {
    let mut e = Encoder {
        x,
        prog: Vec::new(),
        lits: Vec::new(),
        table: vec![(0u32, 0u32); 1 << HASH_BITS]
            .into_boxed_slice()
            .try_into()
            .map_err(|_| "procedural: table")?,
        last_period: 0,
        failed: [(0, 0); 4],
        failed_next: 0,
        quiet_until: 0,
    };
    let n = x.len();
    let (mut i, mut lit_start) = (0usize, 0usize);
    while i < n {
        match e.find(i, lit_start) {
            Some((len, c)) => {
                let start = match c {
                    Cand::Repeat { back, .. } => i - back,
                    _ => i,
                };
                e.flush_literal(lit_start, start);
                e.emit(len, c);
                let end = i + len;
                for p in end.saturating_sub(16).max(i)..end {
                    e.insert(p);
                }
                i = end;
                lit_start = i;
            }
            None => i += 1,
        }
    }
    e.flush_literal(lit_start, n);

    let mut out = Vec::with_capacity(e.prog.len() + 10 + e.lits.len() / 2 + 64);
    write_varint(&mut out, e.prog.len() as u64);
    out.extend_from_slice(&e.prog);
    if !e.lits.is_empty() {
        let z = zstd::bulk::compress(&e.lits, level).map_err(|err| format!("zstd: {}", err))?;
        out.extend_from_slice(&z);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varint_edges() {
        for v in [0u64, 1, 127, 128, 300, 1 << 35, u64::MAX - 1, u64::MAX] {
            let mut b = Vec::new();
            write_varint(&mut b, v);
            assert!(b.len() <= 10);
            let mut p = 0;
            assert_eq!(read_varint(&b, &mut p).unwrap(), v);
            assert_eq!(p, b.len());
            // truncation
            let mut p = 0;
            assert!(read_varint(&b[..b.len() - 1], &mut p).is_err());
        }
        // 10th byte > 1 overflows; 11 bytes overflows
        let mut p = 0;
        assert!(read_varint(
            &[0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02],
            &mut p
        )
        .is_err());
        let mut p = 0;
        assert!(read_varint(&[0x80; 11], &mut p).is_err());
    }
}
