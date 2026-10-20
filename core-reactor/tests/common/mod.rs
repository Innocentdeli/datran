//! Deterministic synthetic corpora shared by integration tests.
#![allow(dead_code)]

use core_reactor::evolution::{Engine, EvoConfig};
use std::path::Path;
use std::time::Duration;

pub struct Lcg(pub u64);

impl Lcg {
    pub fn next(&mut self) -> u64 {
        self.0 = self
            .0
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        self.0 >> 33
    }
    pub fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

pub fn random_bytes(n: usize, seed: u64) -> Vec<u8> {
    let mut r = Lcg(seed);
    (0..n).map(|_| r.next() as u8).collect()
}

pub fn text(n: usize, seed: u64) -> Vec<u8> {
    let words = [
        "alpha", "beta", "gamma", "delta", "reactor", "datran", "chunk", "the", "of", "and",
    ];
    let mut r = Lcg(seed);
    let mut out = Vec::with_capacity(n + 16);
    while out.len() < n {
        out.extend_from_slice(words[r.below(words.len() as u64) as usize].as_bytes());
        out.push(if r.below(12) == 0 { b'\n' } else { b' ' });
    }
    out.truncate(n);
    out
}

/// One JSON log line.
pub fn json_log_line(r: &mut Lcg, i: u64) -> String {
    let levels = ["INFO", "INFO", "INFO", "WARN", "DEBUG", "ERROR"];
    let services = ["ingest", "stream", "auth", "lobby", "thumbnail"];
    let msgs = [
        "upload complete",
        "chunk stored",
        "token refreshed",
        "cache miss",
        "session joined",
    ];
    format!(
        "{{\"ts\":\"2026-10-16T12:{:02}:{:02}.{:03}Z\",\"level\":\"{}\",\"service\":\"{}\",\"msg\":\"{}\",\"bytes\":{},\"user\":\"u{}\",\"latency_ms\":{}.{}}}\n",
        (i / 60) % 60,
        i % 60,
        r.below(1000),
        levels[r.below(levels.len() as u64) as usize],
        services[r.below(services.len() as u64) as usize],
        msgs[r.below(msgs.len() as u64) as usize],
        r.below(5_000_000),
        r.below(500),
        r.below(250),
        r.below(10)
    )
}

/// A JSON-lines log document of about `n` bytes.
pub fn json_logs(n: usize, seed: u64) -> Vec<u8> {
    let mut r = Lcg(seed);
    let mut s = String::new();
    let mut i = seed * 1000;
    while s.len() < n {
        s.push_str(&json_log_line(&mut r, i));
        i += 1;
    }
    s.into_bytes()
}

/// A single small JSON record (for dictionary training).
pub fn small_json(seed: u64) -> Vec<u8> {
    let mut r = Lcg(seed);
    let mut s = String::from("[");
    for i in 0..4 {
        if i > 0 {
            s.push(',');
        }
        s.push_str(json_log_line(&mut r, seed + i).trim_end());
    }
    s.push(']');
    s.into_bytes()
}

/// Little-endian f32 sensor readings: smooth signals quantized to 0.01.
pub fn f32_sensor(count: usize, seed: u64) -> Vec<u8> {
    let mut r = Lcg(seed);
    let phase = (seed % 100) as f32 * 0.1;
    let mut out = Vec::with_capacity(count * 4);
    for i in 0..count {
        let noise = (r.below(21) as f32 - 10.0) * 0.01;
        let v = 20.0 + 5.0 * ((i as f32) * 0.01 + phase).sin() + noise;
        let q = (v * 100.0).round() / 100.0;
        out.extend_from_slice(&q.to_le_bytes());
    }
    out
}

pub fn test_config(dir: &Path, seed: u64) -> EvoConfig {
    let mut c = EvoConfig::new(dir);
    c.seed = Some(seed);
    c.interval = Duration::from_millis(0);
    c.max_output = 64 << 20;
    c
}

/// Engine with deterministic RNG and zero timing weights (fitness = mean ln ratio).
pub fn ratio_only_engine(dir: &Path, seed: u64) -> Engine {
    let mut c = test_config(dir, seed);
    c.w_enc = 0.0;
    c.w_dec = 0.0;
    Engine::new(c)
}
