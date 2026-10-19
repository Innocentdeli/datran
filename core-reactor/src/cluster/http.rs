//! Cluster endpoints (NETWORK_SPEC §4). Auth is applied by the router: `x-cluster-token`
//! (constant-time) for peer endpoints, `x-reactor-token` for `/cluster/status`.

use super::{PeerChunk, PeerManifest, PeerObject};
use crate::server::AppState;
use crate::store::{parse_id, ChunkEntry, StoreError};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde_json::json;
use std::collections::{HashMap, HashSet};

fn error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn disabled() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "data gravity disabled (needs the store and REACTOR_CLUSTER_TOKEN)")
}

fn store_err(e: StoreError) -> Response {
    match e {
        StoreError::NotFound => error(StatusCode::NOT_FOUND, "not found"),
        StoreError::Corrupt(m) => error(StatusCode::CONFLICT, m),
        StoreError::KeyUnavailable(m) | StoreError::Busy(m) => error(StatusCode::SERVICE_UNAVAILABLE, m),
        other => error(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
    }
}

/// Peer endpoints (wrap in the `x-cluster-token` layer).
pub fn cluster_routes() -> Router<AppState> {
    Router::new()
        .route("/cluster/inventory", get(inventory))
        .route("/cluster/manifests/:file_id", get(manifest))
        .route("/cluster/objects/:object_id", get(object))
        .route("/cluster/chunks/:chunk_id", get(chunk))
        .route("/cluster/hold/:file_id", post(hold))
        .route("/cluster/unpin/:file_id", post(unpin))
}

/// Operator endpoints (wrap in the `x-reactor-token` layer).
pub fn status_routes() -> Router<AppState> {
    Router::new().route("/cluster/status", get(status))
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tokio::task::spawn_blocking(f).await.map_err(|e| e.to_string())
}

async fn inventory(State(st): State<AppState>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(c) = st.cluster.clone() else { return disabled() };
    let since = q.get("since").and_then(|v| v.parse::<u64>().ok());
    let tsince = q.get("tsince").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    match blocking(move || c.inventory(since, tsince)).await {
        Ok(Ok(inv)) => Json(inv).into_response(),
        Ok(Err(e)) => store_err(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn manifest(State(st): State<AppState>, Path(file_id): Path<String>) -> Response {
    let Some(c) = st.cluster.clone() else { return disabled() };
    let Some(id) = parse_id(&file_id) else { return error(StatusCode::BAD_REQUEST, "invalid file id") };
    let res = blocking(move || -> Result<Option<PeerManifest>, StoreError> {
        let Some((meta, refs)) = c.store.chunk_refs(&id)? else { return Ok(None) };
        let mut seen = HashSet::new();
        let mut objects = Vec::new();
        for r in &refs {
            if seen.insert(r.object_id) {
                let o = c.store.object_meta(&r.object_id)?.ok_or_else(|| StoreError::Corrupt("object vanished".into()))?;
                objects.push(PeerObject {
                    object_id: o.object_id,
                    stored_len: o.stored_len,
                    plain_len: o.plain_len,
                    members: o.members.iter().map(|m| ChunkEntry { id: m.id, len: m.len }).collect(),
                });
            }
        }
        Ok(Some(PeerManifest {
            file_id: id,
            size: meta.size,
            created_ms: meta.created_ms,
            origin: meta.origin,
            chunks: refs.iter().map(|r| PeerChunk { id: r.id, len: r.len, object_id: r.object_id, object_offset: r.object_offset }).collect(),
            objects,
        }))
    })
    .await;
    match res {
        Ok(Ok(Some(m))) => Json(m).into_response(),
        Ok(Ok(None)) => error(StatusCode::NOT_FOUND, "not found"),
        Ok(Err(e)) => store_err(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

fn octets(bytes: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"))], bytes).into_response()
}

async fn object(State(st): State<AppState>, Path(object_id): Path<String>) -> Response {
    let Some(c) = st.cluster.clone() else { return disabled() };
    let Some(id) = parse_id(&object_id) else { return error(StatusCode::BAD_REQUEST, "invalid object id") };
    match blocking(move || c.store.get_object_raw(&id)).await {
        Ok(Ok(Some(raw))) => octets(raw),
        Ok(Ok(None)) => error(StatusCode::NOT_FOUND, "not found"),
        Ok(Err(e)) => store_err(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn chunk(State(st): State<AppState>, Path(chunk_id): Path<String>) -> Response {
    let Some(c) = st.cluster.clone() else { return disabled() };
    let Some(id) = parse_id(&chunk_id) else { return error(StatusCode::BAD_REQUEST, "invalid chunk id") };
    match blocking(move || c.store.read_chunk(&id)).await {
        Ok(Ok(plain)) => octets(plain),
        Ok(Err(e)) => store_err(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn hold(State(st): State<AppState>, Path(file_id): Path<String>, Query(q): Query<HashMap<String, String>>) -> Response {
    let Some(c) = st.cluster.clone() else { return disabled() };
    let Some(id) = parse_id(&file_id) else { return error(StatusCode::BAD_REQUEST, "invalid file id") };
    let requester = q.get("node").cloned().unwrap_or_default();
    let origin = q.get("origin").is_some_and(|v| v == "1" || v == "true");
    let pins = q.get("pins").and_then(|v| v.parse::<u64>().ok()).unwrap_or(0);
    match blocking(move || c.grant_hold(&id, &requester, origin, pins)).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn unpin(State(st): State<AppState>, Path(file_id): Path<String>) -> Response {
    let Some(c) = st.cluster.clone() else { return disabled() };
    let Some(id) = parse_id(&file_id) else { return error(StatusCode::BAD_REQUEST, "invalid file id") };
    match blocking(move || c.unpin_forwarded(&id)).await {
        Ok(r) => Json(r).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

async fn status(State(st): State<AppState>) -> Response {
    let Some(c) = st.cluster.clone() else { return disabled() };
    match blocking(move || c.status()).await {
        Ok(v) => Json(v).into_response(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}
