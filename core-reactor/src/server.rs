//! HTTP API (spec §5).

use crate::codec::{self, DecodeError, DictId};
use crate::evolution::Engine;
use crate::gossip::{constant_time_eq, Gossip};
use crate::reactor::DiocomNativeReactor;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde_json::json;
use std::net::IpAddr;
use std::sync::Arc;

pub const BODY_LIMIT: usize = 500 * 1024 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Engine>,
    pub gossip: Arc<Gossip>,
    /// When set, every non-health, non-gossip endpoint requires a matching `x-reactor-token`.
    pub reactor_token: Option<Arc<Vec<u8>>>,
    pub max_output: usize,
    /// Chunked object store (`/store/*`); `None` disables those endpoints (503).
    pub store: Option<Arc<crate::store::Store>>,
    /// Data gravity (§4); `None` disables `/cluster/*` (503) and remote reads.
    pub cluster: Option<Arc<crate::cluster::Cluster>>,
}

/// Spec §4: refuse a non-loopback bind unless both tokens are set.
pub fn check_bind(ip: IpAddr, has_reactor_token: bool, has_cluster_token: bool) -> Result<(), String> {
    if ip.is_loopback() || (has_reactor_token && has_cluster_token) {
        Ok(())
    } else {
        Err(format!(
            "refusing to bind non-loopback address {} without both REACTOR_TOKEN and REACTOR_CLUSTER_TOKEN",
            ip
        ))
    }
}

fn error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

async fn require_token(State(st): State<AppState>, req: Request, next: Next) -> Response {
    if let Some(expected) = &st.reactor_token {
        let provided = req.headers().get("x-reactor-token").map(|v| v.as_bytes()).unwrap_or(&[]);
        if !constant_time_eq(provided, expected) {
            return error(StatusCode::UNAUTHORIZED, "missing or invalid x-reactor-token");
        }
    }
    next.run(req).await
}

async fn require_cluster(State(st): State<AppState>, req: Request, next: Next) -> Response {
    let cluster_token = st.cluster.as_ref().and_then(|c| c.cfg.cluster_token.as_deref());
    let Some(expected) = st.gossip.cfg.cluster_token.as_deref().or(cluster_token) else {
        return error(StatusCode::NOT_FOUND, "gossip disabled (no REACTOR_CLUSTER_TOKEN)");
    };
    let provided = req.headers().get("x-cluster-token").map(|v| v.as_bytes()).unwrap_or(&[]);
    if !constant_time_eq(provided, expected.as_bytes()) {
        return error(StatusCode::UNAUTHORIZED, "missing or invalid x-cluster-token");
    }
    next.run(req).await
}

/// Who may read `GET /metrics` (NETWORK_SPEC §8): a matching `x-reactor-token` (when the reactor
/// has one), or `Authorization: Bearer <REACTOR_METRICS_TOKEN>`; unauthenticated only with
/// `REACTOR_METRICS_PUBLIC=true` on a loopback bind. With none of these the endpoint answers 401.
#[derive(Clone, Default)]
pub struct MetricsAuth {
    pub token: Option<Arc<Vec<u8>>>,
    pub public: bool,
}

impl MetricsAuth {
    /// `REACTOR_METRICS_TOKEN` / `REACTOR_METRICS_PUBLIC`; public is ignored (with a warning)
    /// unless `bind` is loopback.
    pub fn from_env(bind: IpAddr) -> MetricsAuth {
        let token = std::env::var("REACTOR_METRICS_TOKEN").ok().filter(|t| !t.is_empty()).map(|t| Arc::new(t.into_bytes()));
        let want_public = std::env::var("REACTOR_METRICS_PUBLIC").is_ok_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"));
        if want_public && !bind.is_loopback() {
            tracing::warn!(%bind, "REACTOR_METRICS_PUBLIC ignored on a non-loopback bind; /metrics needs a token");
        }
        MetricsAuth { token, public: want_public && bind.is_loopback() }
    }
}

fn metrics_allowed(st: &AppState, auth: &MetricsAuth, h: &HeaderMap) -> bool {
    if auth.public {
        return true;
    }
    if let Some(expected) = &auth.token {
        let bearer = h.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).map(|v| v.trim().as_bytes());
        if bearer.is_some_and(|b| constant_time_eq(b, expected)) {
            return true;
        }
    }
    if let Some(expected) = &st.reactor_token {
        if let Some(p) = h.get("x-reactor-token") {
            return constant_time_eq(p.as_bytes(), expected);
        }
    }
    false
}

async fn metrics_handler(State((st, auth)): State<(AppState, MetricsAuth)>, h: HeaderMap) -> Response {
    if !metrics_allowed(&st, &auth, &h) {
        return error(StatusCode::UNAUTHORIZED, "metrics need x-reactor-token or Authorization: Bearer <REACTOR_METRICS_TOKEN>");
    }
    let body = tokio::task::spawn_blocking(move || crate::metrics::render(&st.engine, st.store.as_deref(), st.cluster.as_deref())).await.unwrap_or_default();
    ([(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"))], body).into_response()
}

/// A client-supplied `x-request-id` is kept when it is 1–128 visible ASCII characters; otherwise
/// a random 16-byte hex id is generated. Either way it is echoed in the response.
fn request_id(h: &HeaderMap) -> String {
    if let Some(v) = h.get("x-request-id").and_then(|v| v.to_str().ok()) {
        let v = v.trim();
        if !v.is_empty() && v.len() <= 128 && v.bytes().all(|b| (0x21..0x7f).contains(&b)) {
            return v.to_string();
        }
    }
    hex::encode(rand::random::<[u8; 16]>())
}

/// Request id, tracing span, access log line and HTTP metrics for every request.
async fn observe(req: Request, next: Next) -> Response {
    use tracing::Instrument;
    let route = req.extensions().get::<axum::extract::MatchedPath>().map(|m| m.as_str().to_string()).unwrap_or_else(|| "unmatched".into());
    let method = req.method().as_str().to_string();
    let rid = request_id(req.headers());
    let span = tracing::info_span!("request", request_id = %rid, method = %method, route = %route);
    let t = std::time::Instant::now();
    let mut resp = next.run(req).instrument(span.clone()).await;
    let elapsed = t.elapsed();
    let status = resp.status().as_u16();
    crate::metrics::http_request(&route, &method, status, elapsed);
    span.in_scope(|| {
        if route == "/health" || route == "/metrics" {
            tracing::debug!(status, ms = elapsed.as_secs_f64() * 1000.0, "request");
        } else {
            tracing::info!(status, ms = elapsed.as_secs_f64() * 1000.0, "request");
        }
    });
    if let Ok(v) = HeaderValue::from_str(&rid) {
        resp.headers_mut().insert(HeaderName::from_static("x-request-id"), v);
    }
    resp
}

pub fn router(state: AppState) -> Router {
    router_with(state, MetricsAuth::default())
}

pub fn router_with(state: AppState, metrics_auth: MetricsAuth) -> Router {
    let metrics = Router::new().route("/metrics", get(metrics_handler)).with_state((state.clone(), metrics_auth));
    let protected = Router::new()
        .route("/entropy", post(entropy_check))
        .route("/compress", post(compress_handler))
        .route("/decompress", post(decompress_handler))
        .route("/evolution/status", get(status_handler))
        .merge(crate::store::http::routes())
        .merge(crate::cluster::http::status_routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), require_token));
    let cluster = Router::new()
        .route("/evolution/champions", get(champions_handler))
        .route("/evolution/dict/:sha256", get(dict_handler))
        .merge(crate::cluster::http::cluster_routes())
        .route_layer(middleware::from_fn_with_state(state.clone(), require_cluster));
    Router::new()
        .route("/health", get(health_check))
        .merge(protected)
        .merge(cluster)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .with_state(state)
        .merge(metrics)
        .layer(middleware::from_fn(observe))
}

async fn health_check(State(st): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "status": "online",
        "engine": "Datran Native Rust Core Reactor v2.0",
        "arch": std::env::consts::ARCH,
        "os": std::env::consts::OS,
        "max_buffer_mb": BODY_LIMIT / (1024 * 1024),
        "max_output_bytes": st.max_output,
        "evolution": st.engine.cfg.enabled,
        "profile": st.engine.cfg.profile,
        "features": ["shannon_entropy", "symbit_packing", "lz4_flex", "zlib_fast", "blob_v2", "zstd", "brotli", "procedural", "evolution", "gossip", "store", "fusion", "gravity", "metrics", "backup"]
    }))
}

async fn entropy_check(body: Bytes) -> impl IntoResponse {
    let entropy = DiocomNativeReactor::calculate_entropy(&body);
    let routing = if entropy >= 7.8 {
        "raw_bypass"
    } else if entropy < 3.0 {
        "symbit"
    } else {
        "lz4_zlib"
    };
    Json(json!({ "size_bytes": body.len(), "entropy_bits": entropy, "suggested_routing": routing }))
}

fn hv(s: &str) -> HeaderValue {
    HeaderValue::from_str(s).unwrap_or(HeaderValue::from_static("invalid"))
}

async fn compress_handler(State(st): State<AppState>, req_headers: HeaderMap, body: Bytes) -> Response {
    let hint = req_headers
        .get("x-content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(255).collect::<String>());
    let no_sample = req_headers
        .get("x-reactor-no-sample")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| matches!(v.trim(), "1" | "true"));
    let engine = st.engine.clone();
    let task = tokio::task::spawn_blocking(move || {
        let t = std::time::Instant::now();
        let out = engine.compress(&body, hint.as_deref(), !no_sample);
        (out, t.elapsed().as_micros(), body.len())
    });
    let (out, us, original) = match task.await {
        Ok(r) => r,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, format!("reactor task failed: {}", e)),
    };

    let algo = match &out.recipe {
        Some(r) => format!("evo:{}", r.label()),
        None if out.class == crate::classify::MEDIA_COMPRESSED => "raw_bypass".into(),
        None => "raw".into(),
    };
    let ratio = if out.blob.is_empty() { 1.0 } else { original as f64 / out.blob.len() as f64 };
    let mut h = HeaderMap::new();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    let pairs: [(&'static str, String); 10] = [
        ("x-datran-algo", algo),
        ("x-datran-ratio", format!("{:.2}x", ratio)),
        ("x-datran-time-us", us.to_string()),
        ("x-datran-entropy", format!("{:.2}", out.entropy)),
        ("x-reactor-class", out.class.to_string()),
        (
            "x-reactor-recipe",
            out.recipe.as_ref().map(|r| r.to_compact_json()).unwrap_or_else(|| "null".into()),
        ),
        ("x-reactor-format", if out.recipe.is_some() { "v2" } else { "legacy-raw" }.into()),
        ("x-original-size", original.to_string()),
        ("x-compressed-size", out.blob.len().to_string()),
        ("x-reactor-note", out.note.clone().unwrap_or_default().chars().filter(|c| (' '..='~').contains(c)).collect()),
    ];
    for (k, v) in pairs {
        if k == "x-reactor-note" && v.is_empty() {
            continue;
        }
        h.insert(HeaderName::from_static(k), hv(&v));
    }
    (StatusCode::OK, h, out.blob).into_response()
}

fn decode_blocking(st: &AppState, body: Bytes) -> tokio::task::JoinHandle<Result<Vec<u8>, DecodeError>> {
    let engine = st.engine.clone();
    let limit = st.max_output;
    tokio::task::spawn_blocking(move || {
        let t = std::time::Instant::now();
        let r = codec::decode_any(&body, limit, &|id: &DictId| engine.dicts.get(id));
        if let Ok(out) = &r {
            crate::metrics::codec_op("decompress", crate::metrics::blob_codec(&body), out.len() as u64, t.elapsed());
        }
        r
    })
}

async fn decompress_handler(State(st): State<AppState>, body: Bytes) -> Response {
    let mut result = match decode_blocking(&st, body.clone()).await {
        Ok(r) => r,
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, format!("reactor task failed: {}", e)),
    };
    if let Err(DecodeError::UnknownDict(id)) = &result {
        if st.gossip.fetch_dict(&st.engine, id).await {
            result = match decode_blocking(&st, body).await {
                Ok(r) => r,
                Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, format!("reactor task failed: {}", e)),
            };
        }
    }
    match result {
        Ok(data) => {
            ([(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"))], data).into_response()
        }
        Err(DecodeError::UnknownDict(id)) => (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": format!("unknown dictionary {}", hex::encode(id)), "unknown_dict": hex::encode(id) })),
        )
            .into_response(),
        Err(e) => error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

async fn status_handler(State(st): State<AppState>) -> impl IntoResponse {
    let mut v = st.engine.status();
    v["peers"] = json!(st.gossip.peer_status());
    v["gossip_enabled"] = json!(st.gossip.enabled());
    v["share_dictionaries"] = json!(st.gossip.cfg.share_dicts);
    Json(v)
}

async fn champions_handler(State(st): State<AppState>) -> impl IntoResponse {
    let list: Vec<_> = st
        .engine
        .gossip_champions(st.gossip.cfg.share_dicts)
        .into_iter()
        .map(|(class, recipe, fitness)| json!({ "class": class, "recipe": recipe, "fitness": fitness }))
        .collect();
    Json(list)
}

async fn dict_handler(State(st): State<AppState>, Path(sha): Path<String>) -> Response {
    if !st.gossip.cfg.share_dicts {
        return error(StatusCode::NOT_FOUND, "dictionary sharing disabled");
    }
    let id: Option<DictId> = if sha.len() == 64 { hex::decode(&sha).ok().and_then(|b| b.try_into().ok()) } else { None };
    let Some(id) = id else { return error(StatusCode::BAD_REQUEST, "invalid dictionary id") };
    match st.engine.dicts.get(&id) {
        Some(d) => {
            ([(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"))], d.as_ref().clone()).into_response()
        }
        None => error(StatusCode::NOT_FOUND, "unknown dictionary"),
    }
}
