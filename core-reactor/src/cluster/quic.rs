//! Native QUIC transport for node-to-node traffic (NETWORK_SPEC §4 "QUIC transport").
//!
//! HTTP/3 (`h3` + `h3-quinn` over `quinn`) carrying the *same* peer API as the HTTP listener:
//! every request is routed into the axum peer router ([`crate::server::peer_router`]), so there
//! is exactly one set of handlers, one `x-cluster-token` check and one set of response shapes.
//!
//! * **TLS 1.3 only** (QUIC mandates it), `REACTOR_TLS_CERT` / `REACTOR_TLS_KEY` as the server
//!   identity (and as the client identity for mutual TLS); peers are verified against
//!   `REACTOR_TLS_CA` (or the platform roots without it). `REACTOR_QUIC_MTLS=true` makes the
//!   server require a client certificate signed by `REACTOR_TLS_CA`.
//! * **One connection per peer**, many concurrent bidirectional streams (one per request), keep-
//!   alive, idle timeout. Requests are capped per peer (`max_streams`, enforced by both sides).
//! * **0-RTT** only for safe methods (GET/HEAD). The client never sends anything else before the
//!   handshake is confirmed; the server classifies every request stream at accept time with an
//!   exact probe of the TLS state (keying-material export only succeeds once the handshake is
//!   complete) and holds unsafe early requests until the handshake completes (RFC 8470 §3) —
//!   a replayed 0-RTT flight never completes its handshake, so it can never execute a POST.
//!   rustls' stateful ticket store makes 0-RTT tickets single-use per server process.

use super::tls::TlsSettings;
use axum::body::Body;
use axum::Router;
use bytes::{Buf, Bytes};
use futures_util::StreamExt;
use h3::quic::{self as h3q, ConnectionErrorIncoming, StreamErrorIncoming, StreamId};
use http::{Method, StatusCode};
use quinn::{IdleTimeout, VarInt};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use serde::Serialize;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use std::time::{Duration, Instant};
use tokio::sync::{watch, Semaphore};
use tower::ServiceExt;

/// ALPN for HTTP/3.
const ALPN_H3: &[u8] = b"h3";
/// Request bodies accepted on the QUIC listener (the peer API has none).
const MAX_REQUEST_BODY: usize = 64 << 10;
/// Header section limit (both directions).
const MAX_FIELD_SECTION: u64 = 64 << 10;
/// How long an unsafe request received in 0-RTT may wait for the handshake before `425`.
const EARLY_UNSAFE_WAIT: Duration = Duration::from_secs(10);

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn env_bool(name: &str) -> Option<bool> {
    std::env::var(name).ok().map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
}

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

/// Congestion controller (`REACTOR_QUIC_CONGESTION`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Congestion {
    Cubic,
    Bbr,
    NewReno,
}

impl Congestion {
    pub fn parse(s: &str) -> Option<Congestion> {
        match s.trim().to_ascii_lowercase().as_str() {
            "cubic" => Some(Congestion::Cubic),
            "bbr" => Some(Congestion::Bbr),
            "newreno" | "new_reno" | "reno" => Some(Congestion::NewReno),
            _ => None,
        }
    }
}

/// QUIC parameters shared by the listener and the peer client.
#[derive(Clone, Debug)]
pub struct QuicTuning {
    /// `REACTOR_QUIC_MAX_STREAMS` (default 64): concurrent requests per peer connection.
    pub max_streams: u32,
    /// `REACTOR_QUIC_0RTT` (default true): 0-RTT resumption for safe methods.
    pub zero_rtt: bool,
    /// `REACTOR_QUIC_CONGESTION` (default cubic).
    pub congestion: Congestion,
    /// `REACTOR_QUIC_IDLE_TIMEOUT_MS` (default 30 s); keep-alive every third of it.
    pub idle_timeout: Duration,
    /// Per-stream receive window (default 16 MiB: one maximal object in flight per stream).
    pub stream_window: u64,
    /// Per-connection receive / send window (default 64 MiB).
    pub conn_window: u64,
    /// Requested UDP socket buffer size (default 4 MiB; the OS may cap it).
    pub udp_buffer: usize,
    /// Test hook: let the client send unsafe methods in 0-RTT (to prove the server holds them).
    #[doc(hidden)]
    pub unsafe_0rtt_for_tests: bool,
}

impl Default for QuicTuning {
    fn default() -> Self {
        QuicTuning {
            max_streams: 64,
            zero_rtt: true,
            congestion: Congestion::Cubic,
            idle_timeout: Duration::from_secs(30),
            stream_window: 16 << 20,
            conn_window: 64 << 20,
            udp_buffer: 4 << 20,
            unsafe_0rtt_for_tests: false,
        }
    }
}

impl QuicTuning {
    pub fn from_env() -> Result<QuicTuning, String> {
        let mut t = QuicTuning::default();
        if let Ok(v) = std::env::var("REACTOR_QUIC_MAX_STREAMS") {
            t.max_streams = v.trim().parse::<u32>().ok().filter(|n| (1..=4096).contains(n)).ok_or("REACTOR_QUIC_MAX_STREAMS must be 1..=4096")?;
        }
        if let Some(b) = env_bool("REACTOR_QUIC_0RTT") {
            t.zero_rtt = b;
        }
        if let Ok(v) = std::env::var("REACTOR_QUIC_CONGESTION") {
            if !v.trim().is_empty() {
                t.congestion = Congestion::parse(&v).ok_or("REACTOR_QUIC_CONGESTION must be cubic, bbr or newreno")?;
            }
        }
        if let Ok(v) = std::env::var("REACTOR_QUIC_IDLE_TIMEOUT_MS") {
            let ms = v.trim().parse::<u64>().ok().filter(|n| (1_000..=600_000).contains(n)).ok_or("REACTOR_QUIC_IDLE_TIMEOUT_MS must be 1000..=600000")?;
            t.idle_timeout = Duration::from_millis(ms);
        }
        Ok(t)
    }

    fn transport(&self, server: bool) -> Result<quinn::TransportConfig, String> {
        let mut tc = quinn::TransportConfig::default();
        // the server accepts request streams; the client accepts none (no server push)
        tc.max_concurrent_bidi_streams(VarInt::from_u32(if server { self.max_streams } else { 0 }));
        tc.max_concurrent_uni_streams(VarInt::from_u32(16));
        tc.stream_receive_window(VarInt::from_u64(self.stream_window).map_err(|_| "stream window too large")?);
        tc.receive_window(VarInt::from_u64(self.conn_window).map_err(|_| "connection window too large")?);
        tc.send_window(self.conn_window);
        tc.max_idle_timeout(Some(IdleTimeout::try_from(self.idle_timeout).map_err(|_| "idle timeout out of range")?));
        tc.keep_alive_interval(Some(self.idle_timeout / 3));
        match self.congestion {
            Congestion::Cubic => {}
            Congestion::Bbr => {
                tc.congestion_controller_factory(Arc::new(quinn::congestion::BbrConfig::default()));
            }
            Congestion::NewReno => {
                tc.congestion_controller_factory(Arc::new(quinn::congestion::NewRenoConfig::default()));
            }
        }
        Ok(tc)
    }
}

// ---------------------------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------------------------

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::aws_lc_rs::default_provider())
}

fn load_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>, String> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_file_iter(path)
        .map_err(|e| format!("{}: {}", path.display(), e))?
        .collect::<Result<_, _>>()
        .map_err(|e| format!("{}: {}", path.display(), e))?;
    if certs.is_empty() {
        return Err(format!("{}: no certificates", path.display()));
    }
    Ok(certs)
}

fn load_key(path: &Path) -> Result<PrivateKeyDer<'static>, String> {
    PrivateKeyDer::from_pem_file(path).map_err(|e| format!("{}: {}", path.display(), e))
}

fn load_roots(path: &Path) -> Result<rustls::RootCertStore, String> {
    let mut roots = rustls::RootCertStore::empty();
    for c in load_certs(path)? {
        roots.add(c).map_err(|e| format!("{}: {}", path.display(), e))?;
    }
    Ok(roots)
}

fn server_crypto(s: &QuicServerSettings) -> Result<rustls::ServerConfig, String> {
    let p = provider();
    let b = rustls::ServerConfig::builder_with_provider(p.clone()).with_protocol_versions(&[&rustls::version::TLS13]).map_err(|e| e.to_string())?;
    let b = match &s.client_ca {
        Some(ca) => {
            let v = rustls::server::WebPkiClientVerifier::builder_with_provider(Arc::new(load_roots(ca)?), p).build().map_err(|e| format!("client verifier: {}", e))?;
            b.with_client_cert_verifier(v)
        }
        None => b.with_no_client_auth(),
    };
    let mut cfg = b.with_single_cert(load_certs(&s.cert)?, load_key(&s.key)?).map_err(|e| format!("REACTOR_TLS_CERT/KEY: {}", e))?;
    cfg.alpn_protocols = vec![ALPN_H3.to_vec()];
    // QUIC requires exactly 0 or u32::MAX; tickets from the (stateful, single-use) in-memory
    // store carry the 0-RTT permission
    cfg.max_early_data_size = if s.tuning.zero_rtt { u32::MAX } else { 0 };
    Ok(cfg)
}

fn client_crypto(ca: Option<&Path>, identity: Option<&TlsSettings>, zero_rtt: bool) -> Result<rustls::ClientConfig, String> {
    let p = provider();
    let b = rustls::ClientConfig::builder_with_provider(p.clone()).with_protocol_versions(&[&rustls::version::TLS13]).map_err(|e| e.to_string())?;
    let b = match ca {
        Some(ca) => b.with_root_certificates(load_roots(ca)?),
        None => b.dangerous().with_custom_certificate_verifier(Arc::new(rustls_platform_verifier::Verifier::new(p).map_err(|e| format!("platform verifier: {}", e))?)),
    };
    let mut cfg = match identity {
        Some(id) => b.with_client_auth_cert(load_certs(&id.cert)?, load_key(&id.key)?).map_err(|e| format!("client certificate: {}", e))?,
        None => b.with_no_client_auth(),
    };
    cfg.alpn_protocols = vec![ALPN_H3.to_vec()];
    cfg.enable_early_data = zero_rtt;
    Ok(cfg)
}

/// Exact "TLS handshake complete" probe: rustls only exports keying material from its traffic
/// states, never while the handshake (and 0-RTT) is still in progress.
fn handshake_complete(conn: &quinn::Connection) -> bool {
    let mut out = [0u8; 8];
    conn.export_keying_material(&mut out, b"datran-quic-handshake-probe", b"").is_ok()
}

fn udp_socket(addr: SocketAddr, buffer: usize) -> std::io::Result<std::net::UdpSocket> {
    use socket2::{Domain, Protocol, Socket, Type};
    let s = Socket::new(Domain::for_address(addr), Type::DGRAM, Some(Protocol::UDP))?;
    if addr.is_ipv6() {
        let _ = s.set_only_v6(false);
    }
    let _ = s.set_recv_buffer_size(buffer);
    let _ = s.set_send_buffer_size(buffer);
    s.bind(&addr.into())?;
    Ok(s.into())
}

fn endpoint(addr: SocketAddr, server: Option<quinn::ServerConfig>, buffer: usize) -> Result<quinn::Endpoint, String> {
    let sock = udp_socket(addr, buffer).map_err(|e| format!("UDP bind {}: {}", addr, e))?;
    quinn::Endpoint::new(quinn::EndpointConfig::default(), server, sock, Arc::new(quinn::TokioRuntime)).map_err(|e| format!("QUIC endpoint {}: {}", addr, e))
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

/// QUIC listener configuration (`REACTOR_QUIC_PORT` & co.).
#[derive(Clone, Debug)]
pub struct QuicServerSettings {
    pub cert: PathBuf,
    pub key: PathBuf,
    /// Mutual TLS: client certificates must chain to this CA (`REACTOR_QUIC_MTLS=true` uses
    /// `REACTOR_TLS_CA`).
    pub client_ca: Option<PathBuf>,
    pub tuning: QuicTuning,
}

impl QuicServerSettings {
    pub fn new(tls: &TlsSettings) -> QuicServerSettings {
        QuicServerSettings { cert: tls.cert.clone(), key: tls.key.clone(), client_ca: None, tuning: QuicTuning::default() }
    }

    /// `Ok(None)` when `REACTOR_QUIC_PORT` is unset or 0. QUIC without a certificate, or mTLS
    /// without a CA, is a configuration error (the reactor refuses to start).
    pub fn from_env(tls: Option<&TlsSettings>) -> Result<Option<(u16, QuicServerSettings)>, String> {
        let port = match std::env::var("REACTOR_QUIC_PORT") {
            Ok(v) if !v.trim().is_empty() => v.trim().parse::<u16>().map_err(|_| format!("invalid REACTOR_QUIC_PORT {:?}", v))?,
            _ => 0,
        };
        if port == 0 {
            return Ok(None);
        }
        let tls = tls.ok_or("REACTOR_QUIC_PORT needs REACTOR_TLS_CERT and REACTOR_TLS_KEY (QUIC is TLS 1.3 only)")?;
        let mut s = QuicServerSettings::new(tls);
        s.tuning = QuicTuning::from_env()?;
        if env_bool("REACTOR_QUIC_MTLS").unwrap_or(false) {
            let ca = std::env::var("REACTOR_TLS_CA").ok().filter(|v| !v.trim().is_empty()).ok_or("REACTOR_QUIC_MTLS=true needs REACTOR_TLS_CA")?;
            s.client_ca = Some(PathBuf::from(ca));
        }
        Ok(Some((port, s)))
    }
}

/// Server-side counters (also exported as Prometheus series).
#[derive(Default, Debug)]
pub struct QuicServerStats {
    pub connections: AtomicU64,
    pub handshake_failures: AtomicU64,
    pub requests: AtomicU64,
    pub response_bytes: AtomicU64,
    /// Requests received before the handshake completed (0-RTT), GET/HEAD.
    pub early_safe: AtomicU64,
    /// Unsafe requests received before the handshake completed (never sent by a conforming
    /// reactor client).
    pub early_unsafe: AtomicU64,
    /// Unsafe early requests executed only after the handshake completed.
    pub early_unsafe_deferred: AtomicU64,
    /// Unsafe early requests refused with 425 (handshake never completed: replay or failure).
    pub early_unsafe_refused: AtomicU64,
}

impl QuicServerStats {
    pub fn json(&self) -> serde_json::Value {
        let ld = |a: &AtomicU64| a.load(Ordering::Relaxed);
        serde_json::json!({
            "connections": ld(&self.connections),
            "handshake_failures": ld(&self.handshake_failures),
            "requests": ld(&self.requests),
            "response_bytes": ld(&self.response_bytes),
            "early_safe": ld(&self.early_safe),
            "early_unsafe": ld(&self.early_unsafe),
            "early_unsafe_deferred": ld(&self.early_unsafe_deferred),
            "early_unsafe_refused": ld(&self.early_unsafe_refused),
        })
    }
}

/// A running QUIC listener.
pub struct QuicServer {
    endpoint: quinn::Endpoint,
    local: SocketAddr,
    pub stats: Arc<QuicServerStats>,
}

impl QuicServer {
    /// Binds `addr` (UDP) and serves `app` (the peer router) over HTTP/3. Must be called inside
    /// a tokio runtime.
    pub fn start(addr: SocketAddr, app: Router, s: &QuicServerSettings) -> Result<QuicServer, String> {
        QuicServer::start_with_stats(addr, app, s, Arc::new(QuicServerStats::default()))
    }

    /// [`QuicServer::start`] recording into existing counters (shared with `/cluster/status`).
    pub fn start_with_stats(addr: SocketAddr, app: Router, s: &QuicServerSettings, stats: Arc<QuicServerStats>) -> Result<QuicServer, String> {
        let crypto = quinn::crypto::rustls::QuicServerConfig::try_from(server_crypto(s)?).map_err(|e| format!("QUIC TLS config: {}", e))?;
        let mut sc = quinn::ServerConfig::with_crypto(Arc::new(crypto));
        sc.transport_config(Arc::new(s.tuning.transport(true)?));
        let endpoint = endpoint(addr, Some(sc), s.tuning.udp_buffer)?;
        let local = endpoint.local_addr().map_err(|e| e.to_string())?;
        let ep = endpoint.clone();
        let st = stats.clone();
        tokio::spawn(async move {
            while let Some(incoming) = ep.accept().await {
                tokio::spawn(serve_connection(incoming, app.clone(), st.clone()));
            }
        });
        Ok(QuicServer { endpoint, local, stats })
    }

    pub fn local_addr(&self) -> SocketAddr {
        self.local
    }

    /// Stops accepting and closes every connection.
    pub fn close(&self) {
        self.endpoint.close(VarInt::from_u32(0), b"shutdown");
    }

    pub async fn wait_idle(&self) {
        self.endpoint.wait_idle().await;
    }
}

/// `h3_quinn::Connection` that marks request streams accepted before the TLS handshake
/// completed (0-RTT) — evaluated synchronously at accept time, so it cannot race the handshake.
struct EarlyTrack {
    inner: h3_quinn::Connection,
    quic: quinn::Connection,
    early: Arc<Mutex<HashMap<StreamId, bool>>>,
}

impl h3q::Connection<Bytes> for EarlyTrack {
    type RecvStream = h3_quinn::RecvStream;
    type OpenStreams = h3_quinn::OpenStreams;

    fn poll_accept_recv(&mut self, cx: &mut Context<'_>) -> Poll<Result<Self::RecvStream, ConnectionErrorIncoming>> {
        h3q::Connection::<Bytes>::poll_accept_recv(&mut self.inner, cx)
    }

    fn poll_accept_bidi(&mut self, cx: &mut Context<'_>) -> Poll<Result<Self::BidiStream, ConnectionErrorIncoming>> {
        let s = match h3q::Connection::<Bytes>::poll_accept_bidi(&mut self.inner, cx) {
            Poll::Ready(Ok(s)) => s,
            other => return other,
        };
        if !handshake_complete(&self.quic) {
            lock(&self.early).insert(h3q::RecvStream::recv_id(&s), true);
        }
        Poll::Ready(Ok(s))
    }

    fn opener(&self) -> Self::OpenStreams {
        h3q::Connection::<Bytes>::opener(&self.inner)
    }
}

impl h3q::OpenStreams<Bytes> for EarlyTrack {
    type BidiStream = h3_quinn::BidiStream<Bytes>;
    type SendStream = h3_quinn::SendStream<Bytes>;

    fn poll_open_bidi(&mut self, cx: &mut Context<'_>) -> Poll<Result<Self::BidiStream, StreamErrorIncoming>> {
        h3q::OpenStreams::<Bytes>::poll_open_bidi(&mut self.inner, cx)
    }

    fn poll_open_send(&mut self, cx: &mut Context<'_>) -> Poll<Result<Self::SendStream, StreamErrorIncoming>> {
        h3q::OpenStreams::<Bytes>::poll_open_send(&mut self.inner, cx)
    }

    fn close(&mut self, code: h3::error::Code, reason: &[u8]) {
        h3q::OpenStreams::<Bytes>::close(&mut self.inner, code, reason)
    }
}

struct ConnGauge(&'static str);

impl ConnGauge {
    fn new(side: &'static str) -> ConnGauge {
        crate::metrics::quic_connections_add(side, 1);
        ConnGauge(side)
    }
}

impl Drop for ConnGauge {
    fn drop(&mut self) {
        crate::metrics::quic_connections_add(self.0, -1);
    }
}

async fn serve_connection(incoming: quinn::Incoming, app: Router, stats: Arc<QuicServerStats>) {
    let connecting = match incoming.accept() {
        Ok(c) => c,
        Err(e) => {
            stats.handshake_failures.fetch_add(1, Ordering::Relaxed);
            crate::metrics::quic_handshake_failure("server");
            tracing::debug!("QUIC accept failed: {}", e);
            return;
        }
    };
    // Servers always "accept" 0.5-RTT (`into_0rtt` cannot fail on the server side); whether a
    // request really arrived early is decided per stream by `EarlyTrack`.
    let (conn, zrtt): (quinn::Connection, Pin<Box<dyn std::future::Future<Output = bool> + Send>>) = match connecting.into_0rtt() {
        Ok((c, z)) => (c, Box::pin(z)),
        Err(connecting) => match connecting.await {
            Ok(c) => (c, Box::pin(std::future::ready(true))),
            Err(e) => {
                stats.handshake_failures.fetch_add(1, Ordering::Relaxed);
                crate::metrics::quic_handshake_failure("server");
                tracing::debug!("QUIC handshake failed: {}", e);
                return;
            }
        },
    };
    let _gauge = ConnGauge::new("server");
    stats.connections.fetch_add(1, Ordering::Relaxed);
    let (confirmed_tx, confirmed_rx) = watch::channel(false);
    {
        let stats = stats.clone();
        let conn = conn.clone();
        tokio::spawn(async move {
            // Server side, quinn resolves this with "0-RTT accepted" (false after a full
            // handshake); only the TLS state tells whether the handshake completed.
            let _ = zrtt.await;
            if handshake_complete(&conn) {
                confirmed_tx.send_replace(true);
            } else {
                stats.handshake_failures.fetch_add(1, Ordering::Relaxed);
                crate::metrics::quic_handshake_failure("server");
                tracing::debug!(reason = ?conn.close_reason(), "QUIC handshake did not complete");
            }
        });
    }
    let early = Arc::new(Mutex::new(HashMap::new()));
    let tracked = EarlyTrack { inner: h3_quinn::Connection::new(conn.clone()), quic: conn.clone(), early: early.clone() };
    let mut h3c = match h3::server::builder().max_field_section_size(MAX_FIELD_SECTION).build::<_, Bytes>(tracked).await {
        Ok(c) => c,
        Err(e) => {
            tracing::debug!("HTTP/3 setup failed: {}", e);
            return;
        }
    };
    loop {
        match h3c.accept().await {
            Ok(Some(resolver)) => {
                let app = app.clone();
                let stats = stats.clone();
                let early = early.clone();
                let confirmed = confirmed_rx.clone();
                let conn = conn.clone();
                tokio::spawn(async move {
                    let (req, stream) = match resolver.resolve_request().await {
                        Ok(x) => x,
                        Err(e) => {
                            tracing::debug!("bad HTTP/3 request: {}", e);
                            return;
                        }
                    };
                    let was_early = lock(&early).remove(&stream.id()).unwrap_or(false);
                    serve_request(req, stream, app, &stats, was_early, confirmed, &conn).await;
                });
            }
            Ok(None) => break,
            Err(e) => {
                if !e.is_h3_no_error() {
                    tracing::debug!("HTTP/3 connection ended: {}", e);
                }
                break;
            }
        }
    }
}

type H3Stream = h3::server::RequestStream<h3_quinn::BidiStream<Bytes>, Bytes>;

fn is_safe(m: &Method) -> bool {
    *m == Method::GET || *m == Method::HEAD
}

async fn serve_request(
    req: http::Request<()>,
    stream: H3Stream,
    app: Router,
    stats: &QuicServerStats,
    was_early: bool,
    mut confirmed: watch::Receiver<bool>,
    conn: &quinn::Connection,
) {
    let method = req.method().clone();
    let safe = is_safe(&method);
    stats.requests.fetch_add(1, Ordering::Relaxed);
    let (mut send, mut recv) = stream.split();
    if was_early {
        crate::metrics::quic_early_request(safe);
        if safe {
            stats.early_safe.fetch_add(1, Ordering::Relaxed);
        } else {
            // RFC 8470 §3: hold the request until the handshake proves the client is live.
            stats.early_unsafe.fetch_add(1, Ordering::Relaxed);
            if !handshake_complete(conn) {
                let _ = tokio::time::timeout(EARLY_UNSAFE_WAIT, confirmed.wait_for(|c| *c)).await;
            }
            if !handshake_complete(conn) {
                stats.early_unsafe_refused.fetch_add(1, Ordering::Relaxed);
                let resp = http::Response::builder().status(StatusCode::TOO_EARLY).body(()).unwrap_or_default();
                let _ = send.send_response(resp).await;
                let _ = send.finish().await;
                crate::metrics::quic_server_request(method.as_str(), 425, 0);
                return;
            }
            stats.early_unsafe_deferred.fetch_add(1, Ordering::Relaxed);
        }
    }
    // request body (the peer API sends none; cap it anyway)
    let mut body = Vec::new();
    loop {
        match recv.recv_data().await {
            Ok(Some(mut chunk)) => {
                if body.len() + chunk.remaining() > MAX_REQUEST_BODY {
                    recv.stop_sending(h3::error::Code::H3_REQUEST_REJECTED);
                    let resp = http::Response::builder().status(StatusCode::PAYLOAD_TOO_LARGE).body(()).unwrap_or_default();
                    let _ = send.send_response(resp).await;
                    let _ = send.finish().await;
                    crate::metrics::quic_server_request(method.as_str(), 413, 0);
                    return;
                }
                while chunk.has_remaining() {
                    let c = chunk.chunk();
                    let n = c.len();
                    body.extend_from_slice(c);
                    chunk.advance(n);
                }
            }
            Ok(None) => break,
            Err(e) => {
                tracing::debug!("HTTP/3 request body: {}", e);
                return;
            }
        }
    }
    let (parts, ()) = req.into_parts();
    let resp = match app.oneshot(http::Request::from_parts(parts, Body::from(body))).await {
        Ok(r) => r,
        Err(never) => match never {},
    };
    let (mut head, body) = resp.into_parts();
    for h in ["connection", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection"] {
        head.headers.remove(h);
    }
    let status = head.status.as_u16();
    if send.send_response(http::Response::from_parts(head, ())).await.is_err() {
        return;
    }
    let mut sent = 0u64;
    let mut data = body.into_data_stream();
    while let Some(chunk) = data.next().await {
        match chunk {
            Ok(b) => {
                sent += b.len() as u64;
                if send.send_data(b).await.is_err() {
                    return;
                }
            }
            Err(e) => {
                tracing::debug!("response body failed: {}", e);
                send.stop_stream(h3::error::Code::H3_INTERNAL_ERROR);
                return;
            }
        }
    }
    let _ = send.finish().await;
    stats.response_bytes.fetch_add(sent, Ordering::Relaxed);
    crate::metrics::quic_server_request(method.as_str(), status, sent);
}

// ---------------------------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------------------------


/// Why a QUIC request failed.
#[derive(Debug)]
pub enum QuicError {
    /// No usable connection: handshake failed, timed out or was refused (TLS / mTLS). The
    /// caller may fall back to HTTP(S).
    Handshake(String),
    /// The peer answered with a non-success status.
    Status(u16),
    /// Anything after the connection was established.
    Request(String),
}

impl std::fmt::Display for QuicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QuicError::Handshake(m) | QuicError::Request(m) => write!(f, "{}", m),
            QuicError::Status(s) => write!(f, "HTTP {}", s),
        }
    }
}

/// Client-side counters.
#[derive(Default, Debug)]
pub struct QuicClientStats {
    pub connections: AtomicU64,
    pub handshake_failures: AtomicU64,
    pub zero_rtt_accepted: AtomicU64,
    pub zero_rtt_rejected: AtomicU64,
    /// Requests sent before the handshake was confirmed (0-RTT), safe methods.
    pub early_sent_safe: AtomicU64,
    /// Unsafe requests sent in 0-RTT (only with the test hook; always 0 in production).
    pub early_sent_unsafe: AtomicU64,
    pub reconnects: AtomicU64,
}

impl QuicClientStats {
    pub fn json(&self) -> serde_json::Value {
        let ld = |a: &AtomicU64| a.load(Ordering::Relaxed);
        serde_json::json!({
            "connections": ld(&self.connections),
            "handshake_failures": ld(&self.handshake_failures),
            "zero_rtt_accepted": ld(&self.zero_rtt_accepted),
            "zero_rtt_rejected": ld(&self.zero_rtt_rejected),
            "early_sent_safe": ld(&self.early_sent_safe),
            "early_sent_unsafe": ld(&self.early_sent_unsafe),
            "reconnects": ld(&self.reconnects),
        })
    }
}

/// Handshake state of a pooled connection.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Hs {
    /// 0-RTT: safe requests may already flow, the handshake is still running.
    Pending,
    Confirmed,
    /// The server rejected the 0-RTT data (the connection is unusable; retry with 1-RTT).
    Rejected,
    /// The handshake failed.
    Failed,
}

struct PeerConn {
    quic: quinn::Connection,
    send: h3::client::SendRequest<h3_quinn::OpenStreams, Bytes>,
    hs: watch::Receiver<Hs>,
    streams: Arc<Semaphore>,
    dead: Arc<AtomicBool>,
    created: Instant,
    _gauge: ConnGauge,
}

impl PeerConn {
    fn usable(&self) -> bool {
        !self.dead.load(Ordering::Relaxed) && self.quic.close_reason().is_none() && matches!(*self.hs.borrow(), Hs::Pending | Hs::Confirmed)
    }
}

/// Settings of the QUIC peer client.
#[derive(Clone, Debug)]
pub struct QuicClientSettings {
    /// Trust anchors for peer certificates (`REACTOR_TLS_CA`); platform roots without it.
    pub tls_ca: Option<PathBuf>,
    /// Client certificate presented for mutual TLS (`REACTOR_TLS_CERT` / `REACTOR_TLS_KEY`).
    pub identity: Option<TlsSettings>,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
    pub tuning: QuicTuning,
}

type Slot = Arc<tokio::sync::Mutex<Option<Arc<PeerConn>>>>;

/// One QUIC connection per peer (`host:port`), many concurrent request streams.
pub struct QuicClient {
    cfg: QuicClientSettings,
    /// TLS settings shared by all peers; each peer gets a copy with its own session cache.
    crypto: rustls::ClientConfig,
    transport: Arc<quinn::TransportConfig>,
    /// Per-authority client configs: rustls keys tickets by server name only, so peers sharing
    /// an IP (different ports) must not see each other's tickets (0-RTT would be rejected).
    configs: Mutex<HashMap<String, quinn::ClientConfig>>,
    /// Peers whose last 0-RTT attempt was rejected: the next connection uses a full handshake.
    no_0rtt: Arc<Mutex<std::collections::HashSet<String>>>,
    endpoints: Mutex<[Option<quinn::Endpoint>; 2]>,
    conns: Mutex<HashMap<String, Slot>>,
    pub stats: Arc<QuicClientStats>,
}

/// TLS server name of a `host:port` authority (IPv6 literals in brackets).
fn server_name(authority: &str) -> &str {
    let host = match authority.rfind(':') {
        Some(i) if !authority[i + 1..].contains(']') => &authority[..i],
        _ => authority,
    };
    host.trim_start_matches('[').trim_end_matches(']')
}

/// The connection was closed by a TLS alert (certificate refused, unknown CA, mTLS required).
fn tls_refused(conn: &quinn::Connection) -> bool {
    let code = match conn.close_reason() {
        Some(quinn::ConnectionError::TransportError(t)) => t.code,
        Some(quinn::ConnectionError::ConnectionClosed(c)) => c.error_code,
        _ => return false,
    };
    (0x100..0x200).contains(&u64::from(code))
}

fn describe(conn: &quinn::Connection, msg: &str) -> String {
    match conn.close_reason() {
        Some(r) if !msg.contains(&r.to_string()) => format!("{} ({})", msg, r),
        _ => msg.to_string(),
    }
}

impl QuicClient {
    pub fn new(cfg: QuicClientSettings) -> Result<QuicClient, String> {
        let crypto = client_crypto(cfg.tls_ca.as_deref(), cfg.identity.as_ref(), cfg.tuning.zero_rtt)?;
        // validate once (TLS 1.3 initial suite present)
        quinn::crypto::rustls::QuicClientConfig::try_from(crypto.clone()).map_err(|e| format!("QUIC client TLS config: {}", e))?;
        let transport = Arc::new(cfg.tuning.transport(false)?);
        Ok(QuicClient {
            cfg,
            crypto,
            transport,
            configs: Mutex::new(HashMap::new()),
            no_0rtt: Arc::new(Mutex::new(Default::default())),
            endpoints: Mutex::new([None, None]),
            conns: Mutex::new(HashMap::new()),
            stats: Arc::new(QuicClientStats::default()),
        })
    }

    fn client_config(&self, authority: &str) -> Result<quinn::ClientConfig, String> {
        let mut configs = lock(&self.configs);
        if let Some(c) = configs.get(authority) {
            return Ok(c.clone());
        }
        let mut crypto = self.crypto.clone();
        crypto.resumption = rustls::client::Resumption::in_memory_sessions(8);
        let qc = quinn::crypto::rustls::QuicClientConfig::try_from(crypto).map_err(|e| format!("QUIC client TLS config: {}", e))?;
        let mut c = quinn::ClientConfig::new(Arc::new(qc));
        c.transport_config(self.transport.clone());
        configs.insert(authority.to_string(), c.clone());
        Ok(c)
    }

    fn endpoint_for(&self, addr: &SocketAddr) -> Result<quinn::Endpoint, String> {
        let i = usize::from(addr.is_ipv6());
        let mut eps = lock(&self.endpoints);
        if let Some(e) = &eps[i] {
            return Ok(e.clone());
        }
        let bind = if addr.is_ipv6() { SocketAddr::from(([0u16; 8], 0)) } else { SocketAddr::from(([0u8; 4], 0)) };
        let e = endpoint(bind, None, self.cfg.tuning.udp_buffer)?;
        eps[i] = Some(e.clone());
        Ok(e)
    }

    /// Closes every pooled connection (the next request reconnects — with 0-RTT when the
    /// peer issued a ticket).
    pub fn reset(&self) {
        let slots: Vec<Slot> = lock(&self.conns).drain().map(|(_, s)| s).collect();
        for s in slots {
            if let Ok(g) = s.try_lock() {
                if let Some(pc) = g.as_ref() {
                    pc.dead.store(true, Ordering::Relaxed);
                    pc.quic.close(VarInt::from_u32(0), b"reset");
                }
            }
        }
    }

    /// Open, usable pooled connections.
    pub fn open_connections(&self) -> usize {
        lock(&self.conns).values().filter(|s| s.try_lock().ok().is_some_and(|g| g.as_ref().is_some_and(|pc| pc.usable()))).count()
    }

    async fn connection(&self, authority: &str, allow_0rtt: bool) -> Result<Arc<PeerConn>, String> {
        let slot = lock(&self.conns).entry(authority.to_string()).or_default().clone();
        let mut g = slot.lock().await;
        if let Some(pc) = g.as_ref() {
            if pc.usable() {
                return Ok(pc.clone());
            }
            self.stats.reconnects.fetch_add(1, Ordering::Relaxed);
        }
        *g = None;
        let early = allow_0rtt && self.cfg.tuning.zero_rtt && !lock(&self.no_0rtt).contains(authority);
        let pc = match self.connect(authority, early).await {
            Ok(pc) => pc,
            Err(e) if early => {
                // the early connection broke during HTTP/3 setup (0-RTT rejected right away)
                tracing::debug!("0-RTT connection to {} failed ({}); retrying with a full handshake", authority, e);
                lock(&self.no_0rtt).insert(authority.to_string());
                self.connect(authority, false).await?
            }
            Err(e) => return Err(e),
        };
        let pc = Arc::new(pc);
        *g = Some(pc.clone());
        Ok(pc)
    }

    async fn connect(&self, authority: &str, allow_0rtt: bool) -> Result<PeerConn, String> {
        let addr = tokio::net::lookup_host(authority)
            .await
            .map_err(|e| format!("resolve {}: {}", authority, e))?
            .next()
            .ok_or_else(|| format!("resolve {}: no address", authority))?;
        let ep = self.endpoint_for(&addr)?;
        let connecting = ep.connect_with(self.client_config(authority)?, addr, server_name(authority)).map_err(|e| format!("QUIC connect {}: {}", authority, e))?;
        let attempt = if allow_0rtt { connecting.into_0rtt() } else { Err(connecting) };
        let (conn, zrtt) = match attempt {
            Ok((c, z)) => (c, Some(z)),
            Err(connecting) => match tokio::time::timeout(self.cfg.connect_timeout, connecting).await {
                Ok(Ok(c)) => {
                    lock(&self.no_0rtt).remove(authority);
                    (c, None)
                }
                Ok(Err(e)) => return Err(format!("QUIC handshake with {}: {}", authority, e)),
                Err(_) => return Err(format!("QUIC handshake with {} timed out after {:?}", authority, self.cfg.connect_timeout)),
            },
        };
        let (hs_tx, hs_rx) = watch::channel(if zrtt.is_some() { Hs::Pending } else { Hs::Confirmed });
        let dead = Arc::new(AtomicBool::new(false));
        if let Some(z) = zrtt {
            let conn = conn.clone();
            let dead = dead.clone();
            let stats = self.stats.clone();
            let no_0rtt = self.no_0rtt.clone();
            let authority = authority.to_string();
            tokio::spawn(async move {
                let accepted = z.await;
                let state = if !handshake_complete(&conn) {
                    Hs::Failed
                } else if accepted {
                    stats.zero_rtt_accepted.fetch_add(1, Ordering::Relaxed);
                    crate::metrics::quic_0rtt(true);
                    Hs::Confirmed
                } else {
                    // the early HTTP/3 control streams are gone: this connection is unusable
                    stats.zero_rtt_rejected.fetch_add(1, Ordering::Relaxed);
                    crate::metrics::quic_0rtt(false);
                    lock(&no_0rtt).insert(authority);
                    conn.close(VarInt::from_u32(0), b"0-rtt rejected");
                    Hs::Rejected
                };
                if state != Hs::Confirmed {
                    dead.store(true, Ordering::Relaxed);
                }
                hs_tx.send_replace(state);
            });
        }
        let (mut driver, send) = h3::client::builder()
            .max_field_section_size(MAX_FIELD_SECTION)
            .build::<_, _, Bytes>(h3_quinn::Connection::new(conn.clone()))
            .await
            .map_err(|e| format!("HTTP/3 setup with {}: {}", authority, e))?;
        {
            let dead = dead.clone();
            tokio::spawn(async move {
                let e = std::future::poll_fn(|cx| driver.poll_close(cx)).await;
                if !e.is_h3_no_error() {
                    tracing::debug!("HTTP/3 peer connection closed: {}", e);
                }
                dead.store(true, Ordering::Relaxed);
            });
        }
        self.stats.connections.fetch_add(1, Ordering::Relaxed);
        Ok(PeerConn {
            quic: conn,
            send,
            hs: hs_rx,
            streams: Arc::new(Semaphore::new(self.cfg.tuning.max_streams as usize)),
            dead,
            created: Instant::now(),
            _gauge: ConnGauge::new("client"),
        })
    }

    fn handshake_failed(&self, msg: String) -> QuicError {
        self.stats.handshake_failures.fetch_add(1, Ordering::Relaxed);
        crate::metrics::quic_handshake_failure("client");
        QuicError::Handshake(msg)
    }

    /// One request on the peer's pooled connection; the body is read up to `cap` bytes, the
    /// whole exchange bounded by the request timeout. A connection that never got through its
    /// handshake (or was refused by a TLS alert) yields [`QuicError::Handshake`].
    pub async fn request(&self, method: Method, authority: &str, path_and_query: &str, token: &str, cap: usize) -> Result<Vec<u8>, QuicError> {
        let safe = is_safe(&method);
        let mut allow_0rtt = true;
        let mut reconnected = false;
        for _ in 0..3 {
            let pc = match self.connection(authority, allow_0rtt).await {
                Ok(pc) => pc,
                Err(e) => return Err(self.handshake_failed(e)),
            };
            let r = match tokio::time::timeout(self.cfg.request_timeout, self.on_conn(&pc, method.clone(), authority, path_and_query, token, cap)).await {
                Ok(r) => r,
                Err(_) => Err(QuicError::Request(format!("request timed out after {:?}", self.cfg.request_timeout))),
            };
            let e = match r {
                Ok(b) => return Ok(b),
                Err(QuicError::Status(s)) => return Err(QuicError::Status(s)),
                Err(e) => e,
            };
            // an early connection's stream may fail before the 0-RTT verdict is published
            let mut hs_rx = pc.hs.clone();
            if *hs_rx.borrow() == Hs::Pending {
                let remaining = self.cfg.connect_timeout.saturating_sub(pc.created.elapsed());
                let _ = tokio::time::timeout(remaining, hs_rx.wait_for(|s| *s != Hs::Pending)).await;
            }
            let hs = *pc.hs.borrow();
            let msg = describe(&pc.quic, &e.to_string());
            if hs == Hs::Rejected && allow_0rtt {
                // 0-RTT data rejected: nothing was processed, retry with a full handshake
                allow_0rtt = false;
                continue;
            }
            if (hs != Hs::Confirmed && !handshake_complete(&pc.quic)) || tls_refused(&pc.quic) {
                pc.dead.store(true, Ordering::Relaxed);
                return Err(self.handshake_failed(format!("QUIC handshake with {}: {}", authority, msg)));
            }
            if pc.quic.close_reason().is_some() || pc.dead.load(Ordering::Relaxed) {
                pc.dead.store(true, Ordering::Relaxed);
                if !reconnected && safe {
                    // a pooled connection died (peer restart, idle timeout): reconnect once
                    reconnected = true;
                    continue;
                }
            }
            return Err(QuicError::Request(msg));
        }
        Err(QuicError::Request("QUIC request failed after reconnecting".into()))
    }

    async fn on_conn(&self, pc: &PeerConn, method: Method, authority: &str, pq: &str, token: &str, cap: usize) -> Result<Vec<u8>, QuicError> {
        let _permit = pc.streams.acquire().await.map_err(|_| QuicError::Request("connection closed".into()))?;
        let safe = is_safe(&method);
        let mut hs = pc.hs.clone();
        let state = *hs.borrow();
        match state {
            Hs::Rejected | Hs::Failed => return Err(QuicError::Handshake("handshake failed".into())),
            Hs::Pending if !safe && !self.cfg.tuning.unsafe_0rtt_for_tests => {
                // never send a non-idempotent request in 0-RTT: wait for the handshake
                let remaining = self.cfg.connect_timeout.saturating_sub(pc.created.elapsed());
                match tokio::time::timeout(remaining, hs.wait_for(|s| *s != Hs::Pending)).await.map(|r| r.map(|s| *s)) {
                    Ok(Ok(Hs::Confirmed)) => {}
                    _ => return Err(QuicError::Handshake("handshake not confirmed".into())),
                }
            }
            Hs::Pending if safe => {
                self.stats.early_sent_safe.fetch_add(1, Ordering::Relaxed);
            }
            Hs::Pending => {
                self.stats.early_sent_unsafe.fetch_add(1, Ordering::Relaxed);
            }
            Hs::Confirmed => {}
        }
        let req = http::Request::builder()
            .method(method)
            .uri(format!("https://{}{}", authority, pq))
            .header("x-cluster-token", token)
            .body(())
            .map_err(|e| QuicError::Request(format!("bad request: {}", e)))?;
        let exchange = async {
            let mut send = pc.send.clone();
            let mut s = send.send_request(req).await.map_err(|e| QuicError::Request(format!("request failed: {}", e)))?;
            s.finish().await.map_err(|e| QuicError::Request(format!("request failed: {}", e)))?;
            let resp = s.recv_response().await.map_err(|e| QuicError::Request(format!("request failed: {}", e)))?;
            if !resp.status().is_success() {
                s.stop_sending(h3::error::Code::H3_NO_ERROR);
                return Err(QuicError::Status(resp.status().as_u16()));
            }
            let cl = resp.headers().get(http::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok());
            if cl.is_some_and(|l| l > cap as u64) {
                s.stop_sending(h3::error::Code::H3_REQUEST_CANCELLED);
                return Err(QuicError::Request(format!("response larger than {} bytes", cap)));
            }
            let mut buf = Vec::with_capacity(cl.unwrap_or(0).min(cap as u64) as usize);
            while let Some(mut chunk) = s.recv_data().await.map_err(|e| QuicError::Request(format!("read failed: {}", e)))? {
                if buf.len() + chunk.remaining() > cap {
                    s.stop_sending(h3::error::Code::H3_REQUEST_CANCELLED);
                    return Err(QuicError::Request(format!("response larger than {} bytes", cap)));
                }
                while chunk.has_remaining() {
                    let c = chunk.chunk();
                    let n = c.len();
                    buf.extend_from_slice(c);
                    chunk.advance(n);
                }
            }
            Ok(buf)
        };
        if state != Hs::Pending {
            return exchange.await;
        }
        // early request: the handshake must still finish within the connect timeout
        let deadline = async {
            let remaining = self.cfg.connect_timeout.saturating_sub(pc.created.elapsed());
            match tokio::time::timeout(remaining, hs.wait_for(|s| *s != Hs::Pending)).await.map(|r| r.map(|s| *s)) {
                Ok(Ok(Hs::Confirmed)) => std::future::pending::<QuicError>().await,
                Ok(Ok(_)) => QuicError::Handshake("0-RTT rejected or handshake failed".into()),
                _ => QuicError::Handshake(format!("handshake not confirmed within {:?}", self.cfg.connect_timeout)),
            }
        };
        tokio::select! {
            r = exchange => r,
            e = deadline => Err(e),
        }
    }
}