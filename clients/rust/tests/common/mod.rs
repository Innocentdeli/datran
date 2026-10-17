//! Live reactor for integration tests: REACTOR_URL (+REACTOR_TOKEN), or REACTOR_BIN started on an
//! ephemeral port with a temp state dir (falls back to ../../core-reactor/target/release/core-reactor[.exe]).
#![allow(dead_code)]

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct Reactor {
    pub url: String,
    pub token: Option<String>,
    child: Option<Child>,
    dir: Option<PathBuf>,
}

impl Drop for Reactor {
    fn drop(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        if let Some(d) = self.dir.take() {
            let _ = std::fs::remove_dir_all(d);
        }
    }
}

fn default_bin() -> Option<PathBuf> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../core-reactor/target/release");
    ["core-reactor.exe", "core-reactor"].iter().map(|n| root.join(n)).find(|p| p.is_file())
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

/// Returns `None` (test should skip) when no reactor is configured.
pub fn start() -> Option<Reactor> {
    if let Ok(url) = std::env::var("REACTOR_URL") {
        if !url.is_empty() {
            let token = std::env::var("REACTOR_TOKEN").ok().filter(|t| !t.is_empty());
            return Some(Reactor { url: url.trim_end_matches('/').into(), token, child: None, dir: None });
        }
    }
    let bin = std::env::var("REACTOR_BIN").ok().filter(|b| !b.is_empty()).map(PathBuf::from).or_else(default_bin);
    let Some(bin) = bin else {
        eprintln!("SKIPPED: no reactor (set REACTOR_BIN or REACTOR_URL)");
        return None;
    };
    let port = free_port();
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("datran-rs-{}-{}", std::process::id(), nanos));
    std::fs::create_dir_all(&dir).unwrap();
    let token = std::env::var("REACTOR_TOKEN").ok().filter(|t| !t.is_empty()).unwrap_or_else(|| format!("test-{:x}", nanos));
    let child = Command::new(&bin)
        .env("REACTOR_PORT", port.to_string())
        .env("REACTOR_TOKEN", &token)
        .env("REACTOR_STATE_DIR", &dir)
        .env("REACTOR_BIND", "127.0.0.1")
        .env_remove("REACTOR_CLUSTER_TOKEN")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap_or_else(|e| panic!("failed to start {}: {}", bin.display(), e));
    let mut r = Reactor { url: format!("http://127.0.0.1:{}", port), token: Some(token), child: Some(child), dir: Some(dir) };
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if let Some(st) = r.child.as_mut().unwrap().try_wait().unwrap() {
            panic!("reactor exited early: {}", st);
        }
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Some(r);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!("reactor did not start listening within 30 s");
}

/// Reactors started from REACTOR_BIN that gossip with each other (data gravity). Dropping stops them.
pub struct Cluster {
    pub nodes: Vec<Reactor>,
    pub token: String,
    pub cluster_token: String,
}

/// Starts `n` reactors with REACTOR_PEERS pointing at each other; `None` (skip) without REACTOR_BIN.
/// REACTOR_MIN_REPLICAS=1 and a huge REACTOR_GRAVITY_PULL keep placement deterministic.
pub fn start_cluster(n: usize, gossip_ms: u64) -> Option<Cluster> {
    let bin = std::env::var("REACTOR_BIN").ok().filter(|b| !b.is_empty()).map(PathBuf::from).or_else(|| {
        if std::env::var("REACTOR_URL").map(|u| !u.is_empty()).unwrap_or(false) {
            None
        } else {
            default_bin()
        }
    });
    let Some(bin) = bin else {
        eprintln!("SKIPPED: cluster tests need REACTOR_BIN");
        return None;
    };
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let token = format!("test-{:x}", nanos);
    let cluster_token = format!("cluster-{:x}", nanos);
    let ports: Vec<u16> = (0..n).map(|_| free_port()).collect();
    let urls: Vec<String> = ports.iter().map(|p| format!("http://127.0.0.1:{}", p)).collect();
    let mut nodes = Vec::new();
    for (i, port) in ports.iter().enumerate() {
        let dir = std::env::temp_dir().join(format!("datran-rs-c{}-{}-{}", i, std::process::id(), nanos));
        std::fs::create_dir_all(&dir).unwrap();
        let peers: Vec<&str> = urls.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, u)| u.as_str()).collect();
        let child = Command::new(&bin)
            .env("REACTOR_PORT", port.to_string())
            .env("REACTOR_TOKEN", &token)
            .env("REACTOR_STATE_DIR", &dir)
            .env("REACTOR_BIND", "127.0.0.1")
            .env("REACTOR_CLUSTER_TOKEN", &cluster_token)
            .env("REACTOR_PEERS", peers.join(","))
            .env("REACTOR_GOSSIP_INTERVAL_MS", gossip_ms.to_string())
            .env("REACTOR_MIN_REPLICAS", "1")
            .env("REACTOR_GRAVITY_PULL", "1000000")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| panic!("failed to start {}: {}", bin.display(), e));
        nodes.push(Reactor { url: urls[i].clone(), token: Some(token.clone()), child: Some(child), dir: Some(dir) });
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    for (r, port) in nodes.iter_mut().zip(&ports) {
        loop {
            if let Some(st) = r.child.as_mut().unwrap().try_wait().unwrap() {
                panic!("reactor exited early: {}", st);
            }
            if std::net::TcpStream::connect(("127.0.0.1", *port)).is_ok() {
                break;
            }
            assert!(Instant::now() < deadline, "cluster did not start listening within 30 s");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    Some(Cluster { nodes, token, cluster_token })
}

pub fn sample_text(lines: usize) -> Vec<u8> {
    let mut s = String::new();
    for i in 0..lines {
        s.push_str(&format!("{{\"id\":{},\"name\":\"user{}\",\"ok\":{}}}\n", i, i, i % 3 == 0));
    }
    s.into_bytes()
}

/// Deterministic pseudo-random bytes (xorshift64*), incompressible enough for tests.
pub fn random_bytes(n: usize, seed: u64) -> Vec<u8> {
    let mut x = seed | 1;
    let mut out = Vec::with_capacity(n + 8);
    while out.len() < n {
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        out.extend_from_slice(&x.wrapping_mul(0x2545F4914F6CDD1D).to_le_bytes());
    }
    out.truncate(n);
    out
}
