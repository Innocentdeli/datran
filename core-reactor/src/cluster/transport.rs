//! Node-to-node request transport (NETWORK_SPEC §4 "QUIC transport"): every outgoing peer
//! request — inventory gossip, manifests, objects, chunks, hold leases, unpin, recipe
//! champions, dictionary fetch — goes through [`PeerClient`], which picks QUIC (HTTP/3) or
//! HTTP(S) (reqwest) per peer.
//!
//! Peer URLs (`REACTOR_PEERS`): `http://host:port`, `https://host:port` or `quic://host:port`.
//! A `quic://` peer is reached over QUIC at UDP `host:port`, falling back to
//! `https://host:port` (TCP, same port number) when the QUIC handshake fails. With
//! `REACTOR_PEER_TRANSPORT=quic` every `https://` peer is treated the same way;
//! `quic-only` disables the fallback; `http` (default) uses QUIC only for `quic://` peers.
//! After a failed handshake the peer is served over HTTP(S) for `fallback_retry` (60 s) before
//! QUIC is tried again. `http://` peers never use QUIC (no TLS).
//!
//! Both paths share the same caps and timeouts (`request_timeout` for the whole exchange,
//! `connect_timeout` for the TCP connect / QUIC handshake, response size caps per endpoint)
//! and report errors the same way (`HTTP <status>` for a non-success answer).

use super::quic::{QuicClient, QuicClientSettings, QuicError, QuicTuning};
use super::tls::TlsSettings;
use http::Method;
use serde_json::json;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

/// `REACTOR_PEER_TRANSPORT`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum PeerTransport {
    /// QUIC only for `quic://` peers (default).
    #[default]
    Http,
    /// QUIC for `quic://` and `https://` peers, falling back to HTTPS.
    Quic,
    /// QUIC for `quic://` and `https://` peers, no fallback.
    QuicOnly,
}

impl PeerTransport {
    pub fn parse(s: &str) -> Option<PeerTransport> {
        match s.trim().to_ascii_lowercase().as_str() {
            "" | "http" | "https" | "tcp" => Some(PeerTransport::Http),
            "quic" | "h3" => Some(PeerTransport::Quic),
            "quic-only" | "quic_only" => Some(PeerTransport::QuicOnly),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            PeerTransport::Http => "http",
            PeerTransport::Quic => "quic",
            PeerTransport::QuicOnly => "quic-only",
        }
    }
}

/// Peer client configuration.
#[derive(Clone, Debug)]
pub struct TransportConfig {
    pub prefer: PeerTransport,
    /// `REACTOR_TLS_CA`: trust for `https://` and QUIC peers (replaces the built-in roots).
    pub tls_ca: Option<PathBuf>,
    /// Client certificate for QUIC mutual TLS (`REACTOR_TLS_CERT` / `REACTOR_TLS_KEY`).
    pub identity: Option<TlsSettings>,
    pub request_timeout: Duration,
    pub connect_timeout: Duration,
    /// After a failed QUIC handshake, use HTTP(S) for this long before retrying QUIC.
    pub fallback_retry: Duration,
    pub quic: QuicTuning,
}

impl Default for TransportConfig {
    fn default() -> Self {
        TransportConfig {
            prefer: PeerTransport::Http,
            tls_ca: None,
            identity: None,
            request_timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(5),
            fallback_retry: Duration::from_secs(60),
            quic: QuicTuning::default(),
        }
    }
}

impl TransportConfig {
    /// `REACTOR_PEER_TRANSPORT`, `REACTOR_TLS_CA`, `REACTOR_TLS_CERT`/`KEY`, `REACTOR_QUIC_*`.
    pub fn from_env() -> Result<TransportConfig, String> {
        let mut c = TransportConfig::default();
        if let Ok(v) = std::env::var("REACTOR_PEER_TRANSPORT") {
            c.prefer = PeerTransport::parse(&v).ok_or_else(|| format!("invalid REACTOR_PEER_TRANSPORT {:?} (http, quic, quic-only)", v))?;
        }
        c.tls_ca = std::env::var("REACTOR_TLS_CA").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        c.identity = TlsSettings::from_env();
        c.quic = QuicTuning::from_env()?;
        Ok(c)
    }
}

#[derive(Default)]
struct PerTransport {
    requests: AtomicU64,
    errors: AtomicU64,
    bytes: AtomicU64,
}

/// Request counters per transport.
#[derive(Default)]
pub struct TransportStats {
    quic: PerTransport,
    https: PerTransport,
    http: PerTransport,
    pub fallbacks: AtomicU64,
}

impl TransportStats {
    fn of(&self, t: &str) -> &PerTransport {
        match t {
            "quic" => &self.quic,
            "https" => &self.https,
            _ => &self.http,
        }
    }
    pub fn requests(&self, t: &str) -> u64 {
        self.of(t).requests.load(Ordering::Relaxed)
    }
    pub fn errors(&self, t: &str) -> u64 {
        self.of(t).errors.load(Ordering::Relaxed)
    }
    pub fn bytes(&self, t: &str) -> u64 {
        self.of(t).bytes.load(Ordering::Relaxed)
    }
}

/// What this node knows about one peer's transport.
#[derive(Clone, Debug, Default)]
struct PeerState {
    /// Transport of the last request (`quic`, `https`, `http`).
    last: Option<&'static str>,
    quic_error: Option<String>,
    quic_failed_at: Option<Instant>,
    fallbacks: u64,
}

struct Inner {
    cfg: TransportConfig,
    http: reqwest::Client,
    http_unpooled: reqwest::Client,
    rt: Option<tokio::runtime::Handle>,
    quic: OnceLock<Result<Arc<QuicClient>, String>>,
    peers: Mutex<HashMap<String, PeerState>>,
    stats: TransportStats,
}

/// Shared peer client (cheap to clone).
#[derive(Clone)]
pub struct PeerClient {
    inner: Arc<Inner>,
}

/// `scheme://authority/rest` → (scheme, authority, rest).
fn split_url(url: &str) -> Result<(&str, &str, &str), String> {
    let (scheme, rest) = url.split_once("://").ok_or_else(|| format!("invalid peer URL {:?}", url))?;
    let i = rest.find(['/', '?']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(i);
    if authority.is_empty() {
        return Err(format!("invalid peer URL {:?}", url));
    }
    Ok((scheme, authority, if path.is_empty() { "/" } else { path }))
}

fn build_http(cfg: &TransportConfig, pooled: bool) -> Result<reqwest::Client, String> {
    let mut b = reqwest::Client::builder().timeout(cfg.request_timeout).connect_timeout(cfg.connect_timeout).redirect(reqwest::redirect::Policy::none());
    if !pooled {
        b = b.pool_max_idle_per_host(0);
    }
    if let Some(ca) = &cfg.tls_ca {
        let pem = std::fs::read(ca).map_err(|e| format!("REACTOR_TLS_CA {}: {}", ca.display(), e))?;
        let certs = reqwest::Certificate::from_pem_bundle(&pem).map_err(|e| format!("REACTOR_TLS_CA: {}", e))?;
        if certs.is_empty() {
            return Err("REACTOR_TLS_CA contains no certificates".into());
        }
        b = b.tls_certs_only(certs);
    }
    b.build().map_err(|e| format!("failed to build cluster HTTP client: {}", e))
}

/// Sends a request and reads at most `cap` body bytes (content-length checked up front).
async fn send_capped(req: reqwest::RequestBuilder, cap: usize) -> Result<Vec<u8>, String> {
    let mut resp = req.send().await.map_err(|e| format!("request failed: {}", e))?;
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

impl PeerClient {
    /// Builds the client. QUIC needs a tokio runtime (captured here; QUIC requests always run
    /// on it, so callers on private runtimes are fine); without one only HTTP(S) is used.
    pub fn new(cfg: TransportConfig) -> Result<PeerClient, String> {
        let http = build_http(&cfg, true)?;
        let http_unpooled = build_http(&cfg, false)?;
        let rt = tokio::runtime::Handle::try_current().ok();
        Ok(PeerClient {
            inner: Arc::new(Inner { cfg, http, http_unpooled, rt, quic: OnceLock::new(), peers: Mutex::new(HashMap::new()), stats: TransportStats::default() }),
        })
    }

    /// Plain HTTP(S) client with the given timeout (gossip without a cluster).
    pub fn http_only(timeout: Duration) -> PeerClient {
        let cfg = TransportConfig { request_timeout: timeout, connect_timeout: timeout.min(Duration::from_secs(5)), ..TransportConfig::default() };
        PeerClient::new(cfg).expect("failed to build HTTP client")
    }

    pub fn config(&self) -> &TransportConfig {
        &self.inner.cfg
    }

    pub fn stats(&self) -> &TransportStats {
        &self.inner.stats
    }

    fn quic(&self) -> Result<Arc<QuicClient>, String> {
        let c = &self.inner.cfg;
        self.inner
            .quic
            .get_or_init(|| {
                QuicClient::new(QuicClientSettings {
                    tls_ca: c.tls_ca.clone(),
                    identity: c.identity.clone(),
                    connect_timeout: c.connect_timeout,
                    request_timeout: c.request_timeout,
                    tuning: c.quic.clone(),
                })
                .map(Arc::new)
            })
            .clone()
    }

    /// Closes pooled QUIC connections (tests / operators; the next request reconnects).
    pub fn reset_quic(&self) {
        if let Some(Ok(q)) = self.inner.quic.get() {
            q.reset();
        }
    }

    /// Whether a request to `url` would try QUIC first.
    fn wants_quic(&self, scheme: &str) -> bool {
        match scheme {
            "quic" => true,
            "https" => self.inner.cfg.prefer != PeerTransport::Http,
            _ => false,
        }
    }

    pub async fn get(&self, url: &str, token: &str, cap: usize) -> Result<Vec<u8>, String> {
        self.request(Method::GET, url, token, cap, true).await
    }

    pub async fn post(&self, url: &str, token: &str, cap: usize) -> Result<Vec<u8>, String> {
        self.request(Method::POST, url, token, cap, true).await
    }

    /// One peer request with `x-cluster-token`. `pooled = false` uses an HTTP client without
    /// idle connections (for callers on short-lived private runtimes).
    pub async fn request(&self, method: Method, url: &str, token: &str, cap: usize, pooled: bool) -> Result<Vec<u8>, String> {
        let (scheme, authority, rest) = split_url(url)?;
        let quic_only = self.inner.cfg.prefer == PeerTransport::QuicOnly;
        if self.wants_quic(scheme) {
            let backoff = lock(&self.inner.peers)
                .get(authority)
                .and_then(|p| p.quic_failed_at)
                .is_some_and(|t| t.elapsed() < self.inner.cfg.fallback_retry);
            if !backoff || quic_only {
                let t = Instant::now();
                match self.quic_request(method.clone(), authority, rest, token, cap).await {
                    Ok(body) => {
                        self.record("quic", &method, "ok", t, body.len() as u64);
                        let mut peers = lock(&self.inner.peers);
                        let p = peers.entry(authority.to_string()).or_default();
                        p.last = Some("quic");
                        p.quic_error = None;
                        p.quic_failed_at = None;
                        return Ok(body);
                    }
                    Err(QuicError::Status(s)) => {
                        self.record("quic", &method, "http_error", t, 0);
                        lock(&self.inner.peers).entry(authority.to_string()).or_default().last = Some("quic");
                        return Err(format!("HTTP {}", s));
                    }
                    Err(QuicError::Request(e)) => {
                        self.record("quic", &method, "error", t, 0);
                        return Err(format!("QUIC: {}", e));
                    }
                    Err(QuicError::Handshake(e)) => {
                        self.record("quic", &method, "error", t, 0);
                        {
                            let mut peers = lock(&self.inner.peers);
                            let p = peers.entry(authority.to_string()).or_default();
                            p.quic_error = Some(e.chars().take(300).collect());
                            p.quic_failed_at = Some(Instant::now());
                            if !quic_only {
                                p.fallbacks += 1;
                            }
                        }
                        if quic_only {
                            return Err(e);
                        }
                        tracing::warn!(peer = authority, "QUIC unavailable, falling back to HTTPS: {}", e);
                        self.inner.stats.fallbacks.fetch_add(1, Ordering::Relaxed);
                        crate::metrics::peer_fallback();
                    }
                }
            }
        }
        // HTTP(S)
        let (transport, http_url) = match scheme {
            "quic" => ("https", format!("https://{}{}", authority, rest)),
            "https" => ("https", url.to_string()),
            _ => ("http", url.to_string()),
        };
        let client = if pooled { &self.inner.http } else { &self.inner.http_unpooled };
        let t = Instant::now();
        let r = send_capped(client.request(method.clone(), &http_url).header("x-cluster-token", token), cap).await;
        match &r {
            Ok(b) => self.record(transport, &method, "ok", t, b.len() as u64),
            Err(e) if e.starts_with("HTTP ") => self.record(transport, &method, "http_error", t, 0),
            Err(_) => self.record(transport, &method, "error", t, 0),
        }
        if r.as_ref().is_ok() || r.as_ref().is_err_and(|e| e.starts_with("HTTP ")) {
            lock(&self.inner.peers).entry(authority.to_string()).or_default().last = Some(transport);
        }
        r
    }

    async fn quic_request(&self, method: Method, authority: &str, rest: &str, token: &str, cap: usize) -> Result<Vec<u8>, QuicError> {
        let q = self.quic().map_err(QuicError::Handshake)?;
        let rt = self.inner.rt.clone().ok_or_else(|| QuicError::Handshake("QUIC needs a tokio runtime".into()))?;
        let (authority, rest, token) = (authority.to_string(), rest.to_string(), token.to_string());
        // QUIC connections and their drivers live on the runtime the client was built on
        rt.spawn(async move { q.request(method, &authority, &rest, &token, cap).await }).await.map_err(|e| QuicError::Request(e.to_string()))?
    }

    fn record(&self, transport: &'static str, method: &Method, result: &str, t: Instant, bytes: u64) {
        let s = self.inner.stats.of(transport);
        s.requests.fetch_add(1, Ordering::Relaxed);
        if result != "ok" {
            s.errors.fetch_add(1, Ordering::Relaxed);
        }
        s.bytes.fetch_add(bytes, Ordering::Relaxed);
        crate::metrics::peer_request(transport, method.as_str(), result, t.elapsed(), bytes);
    }

    /// Transport view of one peer for `/cluster/status`.
    pub fn peer_json(&self, url: &str) -> serde_json::Value {
        let Ok((scheme, authority, _)) = split_url(url) else { return json!({ "transport": null }) };
        let configured = if self.wants_quic(scheme) {
            "quic"
        } else if scheme == "https" {
            "https"
        } else {
            "http"
        };
        let peers = lock(&self.inner.peers);
        let p = peers.get(authority).cloned().unwrap_or_default();
        json!({
            "transport": p.last.unwrap_or(configured),
            "configured_transport": configured,
            "quic_fallbacks": p.fallbacks,
            "quic_error": p.quic_error,
            "quic_retry_in_ms": p.quic_failed_at.map(|t| self.inner.cfg.fallback_retry.saturating_sub(t.elapsed()).as_millis() as u64),
        })
    }

    /// Transport counters for `/cluster/status`.
    pub fn stats_json(&self) -> serde_json::Value {
        let s = &self.inner.stats;
        let per = |t: &str| json!({ "requests": s.requests(t), "errors": s.errors(t), "response_bytes": s.bytes(t) });
        let quic = match self.inner.quic.get() {
            Some(Ok(q)) => {
                let mut v = q.stats.json();
                v["open_connections"] = json!(q.open_connections());
                v
            }
            Some(Err(e)) => json!({ "error": e }),
            None => serde_json::Value::Null,
        };
        json!({
            "preference": self.inner.cfg.prefer.name(),
            "quic": per("quic"),
            "https": per("https"),
            "http": per("http"),
            "fallbacks": s.fallbacks.load(Ordering::Relaxed),
            "quic_client": quic,
            "quic_settings": {
                "max_streams": self.inner.cfg.quic.max_streams,
                "zero_rtt": self.inner.cfg.quic.zero_rtt,
                "congestion": self.inner.cfg.quic.congestion,
                "idle_timeout_ms": self.inner.cfg.quic.idle_timeout.as_millis() as u64,
            },
        })
    }

    /// QUIC client counters (`None` until the first QUIC request).
    pub fn quic_stats(&self) -> Option<serde_json::Value> {
        match self.inner.quic.get() {
            Some(Ok(q)) => Some(q.stats.json()),
            _ => None,
        }
    }
}
