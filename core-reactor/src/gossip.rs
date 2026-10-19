//! Peer gossip (spec §4): pull champions from peers, adopt valid ones as immigrants (scored locally
//! only), and optionally share zstd dictionaries with SHA-256 verification.

use crate::classify;
use crate::codec::{sha256, DictId};
use crate::dicts::MAX_DICT_BYTES;
use crate::evolution::Engine;
use crate::recipe::Recipe;
use crate::state::now_ms;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Cap on a `/evolution/champions` response body.
pub const MAX_CHAMPIONS_BYTES: usize = 1024 * 1024;
const MAX_CHAMPION_ENTRIES: usize = 256;

#[derive(Clone, Debug)]
pub struct GossipConfig {
    pub peers: Vec<String>,
    pub cluster_token: Option<String>,
    pub interval: Duration,
    pub share_dicts: bool,
    pub timeout: Duration,
}

impl GossipConfig {
    pub fn disabled() -> GossipConfig {
        GossipConfig {
            peers: Vec::new(),
            cluster_token: None,
            interval: Duration::from_secs(60),
            share_dicts: false,
            timeout: Duration::from_secs(10),
        }
    }

    pub fn from_env() -> GossipConfig {
        let mut c = GossipConfig::disabled();
        c.cluster_token = std::env::var("REACTOR_CLUSTER_TOKEN").ok().filter(|t| !t.is_empty());
        c.peers = parse_peers(&std::env::var("REACTOR_PEERS").unwrap_or_default());
        if let Some(ms) = std::env::var("REACTOR_GOSSIP_INTERVAL_MS").ok().and_then(|v| v.trim().parse::<u64>().ok()) {
            c.interval = Duration::from_millis(ms.max(100));
        }
        c.share_dicts = std::env::var("REACTOR_SHARE_DICTIONARIES")
            .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on"))
            .unwrap_or(false);
        c
    }
}

/// Comma-separated base URLs; only http(s) URLs are kept, trailing slashes removed.
pub fn parse_peers(s: &str) -> Vec<String> {
    s.split(',')
        .map(|p| p.trim().trim_end_matches('/').to_string())
        .filter(|p| p.starts_with("http://") || p.starts_with("https://"))
        .collect()
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct PeerStatus {
    pub url: String,
    /// Unix ms of the last successful pull.
    pub last_ok: Option<u64>,
    pub last_error: Option<String>,
    pub last_error_ms: Option<u64>,
    pub immigrants_received: u64,
}

pub struct Gossip {
    pub cfg: GossipConfig,
    client: reqwest::Client,
    status: Mutex<Vec<PeerStatus>>,
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b.iter()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

impl Gossip {
    pub fn new(cfg: GossipConfig) -> Gossip {
        let client = reqwest::Client::builder()
            .timeout(cfg.timeout)
            .connect_timeout(cfg.timeout.min(Duration::from_secs(5)))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build HTTP client");
        let status = cfg.peers.iter().map(|u| PeerStatus { url: u.clone(), ..Default::default() }).collect();
        Gossip { cfg, client, status: Mutex::new(status) }
    }

    /// Gossip endpoints and pulls are disabled without a cluster token.
    pub fn enabled(&self) -> bool {
        self.cfg.cluster_token.is_some()
    }

    pub fn peer_status(&self) -> Vec<PeerStatus> {
        self.status.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn record(&self, url: &str, result: &Result<usize, String>) {
        if let Ok(mut st) = self.status.lock() {
            if let Some(p) = st.iter_mut().find(|p| p.url == url) {
                match result {
                    Ok(n) => {
                        p.last_ok = Some(now_ms());
                        p.last_error = None;
                        p.immigrants_received += *n as u64;
                    }
                    Err(e) => {
                        p.last_error = Some(e.chars().take(300).collect());
                        p.last_error_ms = Some(now_ms());
                    }
                }
            }
        }
    }

    async fn get_capped(&self, url: &str, cap: usize) -> Result<Vec<u8>, String> {
        let token = self.cfg.cluster_token.as_deref().ok_or("no cluster token")?;
        let mut resp = self
            .client
            .get(url)
            .header("x-cluster-token", token)
            .send()
            .await
            .map_err(|e| format!("request failed: {}", e))?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status().as_u16()));
        }
        if resp.content_length().is_some_and(|l| l > cap as u64) {
            return Err(format!("response larger than {} bytes", cap));
        }
        let mut buf = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("read failed: {}", e))? {
            if buf.len() + chunk.len() > cap {
                return Err(format!("response larger than {} bytes", cap));
            }
            buf.extend_from_slice(&chunk);
        }
        Ok(buf)
    }

    /// Fetches a dictionary from one peer, verifies its SHA-256 and stores it.
    async fn fetch_dict_from(&self, engine: &Engine, peer: &str, id: &DictId) -> Result<(), String> {
        let url = format!("{}/evolution/dict/{}", peer, hex::encode(id));
        let bytes = self.get_capped(&url, MAX_DICT_BYTES).await?;
        if sha256(&bytes) != *id {
            return Err("dictionary SHA-256 mismatch".into());
        }
        let store = engine.dicts.clone();
        let id = *id;
        tokio::task::spawn_blocking(move || store.put_verified(&id, bytes))
            .await
            .map_err(|e| e.to_string())?
    }

    /// Tries every peer for an unknown dictionary (only when sharing is enabled).
    pub async fn fetch_dict(&self, engine: &Engine, id: &DictId) -> bool {
        if !self.enabled() || !self.cfg.share_dicts {
            return false;
        }
        for peer in &self.cfg.peers {
            match self.fetch_dict_from(engine, peer, id).await {
                Ok(()) => return true,
                Err(e) => tracing::warn!("dict {} from {}: {}", hex::encode(id), peer, e),
            }
        }
        false
    }

    async fn pull_peer(&self, engine: &Engine, peer: &str) -> Result<usize, String> {
        let body = self.get_capped(&format!("{}/evolution/champions", peer), MAX_CHAMPIONS_BYTES).await?;
        let v: serde_json::Value = serde_json::from_slice(&body).map_err(|e| format!("bad JSON: {}", e))?;
        let items = v.as_array().ok_or("champions response is not an array")?;
        let mut by_class: BTreeMap<&'static str, Vec<Recipe>> = BTreeMap::new();
        for item in items.iter().take(MAX_CHAMPION_ENTRIES) {
            let Some(class) = item.get("class").and_then(|c| c.as_str()).and_then(classify::canonical) else {
                continue;
            };
            if !classify::is_evolvable(class) {
                continue;
            }
            // Peer-reported fitness is informational only and deliberately ignored.
            let Some(recipe) = item.get("recipe").and_then(Recipe::from_json_value) else { continue };
            if let Some(id) = recipe.dict_id() {
                if !self.cfg.share_dicts {
                    continue;
                }
                if !engine.dicts.contains(&id) && self.fetch_dict_from(engine, peer, &id).await.is_err() {
                    continue;
                }
            }
            by_class.entry(class).or_default().push(recipe);
        }
        Ok(by_class.into_iter().map(|(class, recipes)| engine.add_immigrants(class, recipes)).sum())
    }

    /// One gossip round over all peers; returns the number of new immigrants.
    pub async fn pull_once(&self, engine: &Engine) -> usize {
        if !self.enabled() {
            return 0;
        }
        let mut total = 0;
        for peer in &self.cfg.peers {
            let r = self.pull_peer(engine, peer).await;
            self.record(peer, &r);
            if let Ok(n) = r {
                total += n;
            }
        }
        total
    }

    pub fn spawn_loop(
        self: Arc<Self>,
        engine: Arc<Engine>,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> Option<tokio::task::JoinHandle<()>> {
        if !self.enabled() || self.cfg.peers.is_empty() {
            return None;
        }
        Some(tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(self.cfg.interval) => {}
                    _ = shutdown.changed() => break,
                }
                if *shutdown.borrow() {
                    break;
                }
                self.pull_once(&engine).await;
            }
        }))
    }
}
