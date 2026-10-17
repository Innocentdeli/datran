//! `/store/*` endpoints (NETWORK_SPEC §2 "Store HTTP API"); auth is applied by the router.
//!
//! Uploads are streamed: body frames go through a bounded channel into a blocking task that runs
//! FastCDC over a `Read` adapter. Downloads are streamed: a blocking task decodes overlapping
//! objects and pushes verified slices through a bounded channel into the response body.

use super::{parse_id, PutOptions, StoreError};
use crate::server::AppState;
use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, put},
    Router,
};
use futures_util::StreamExt;
use serde_json::json;
use std::io::Read;

/// Frames buffered between the HTTP body and the chunker (each frame is typically ≤ 64 KiB).
const UPLOAD_CHANNEL: usize = 16;
/// Chunks buffered between the decoder and the response body (each ≤ 256 KiB).
const DOWNLOAD_CHANNEL: usize = 4;

fn error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn store_error(e: StoreError) -> Response {
    match e {
        StoreError::NotFound => error(StatusCode::NOT_FOUND, "not found"),
        StoreError::Full { needed, used, max } => (
            StatusCode::INSUFFICIENT_STORAGE,
            Json(json!({ "error": "store full", "needed": needed, "used": used, "max": max })),
        )
            .into_response(),
        StoreError::Invalid(m) => error(StatusCode::BAD_REQUEST, m),
        StoreError::Io(e) if e.kind() == std::io::ErrorKind::UnexpectedEof || e.kind() == std::io::ErrorKind::ConnectionAborted => {
            error(StatusCode::BAD_REQUEST, format!("upload aborted: {}", e))
        }
        other => error(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
    }
}

/// Routes (to be wrapped in the `x-reactor-token` layer by the caller).
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/store/files", put(put_file).layer(DefaultBodyLimit::disable()))
        .route("/store/files/:file_id", get(get_file).head(get_file).delete(delete_file))
        .route("/store/stats", get(stats))
}

fn disabled() -> Response {
    error(StatusCode::SERVICE_UNAVAILABLE, "object store disabled")
}

/// Blocking `Read` over a channel of body frames.
pub struct ChannelReader {
    rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>,
    cur: Bytes,
}

impl ChannelReader {
    pub fn new(rx: tokio::sync::mpsc::Receiver<Result<Bytes, std::io::Error>>) -> ChannelReader {
        ChannelReader { rx, cur: Bytes::new() }
    }
}

impl Read for ChannelReader {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        while self.cur.is_empty() {
            match self.rx.blocking_recv() {
                Some(Ok(b)) => self.cur = b,
                Some(Err(e)) => return Err(e),
                None => return Ok(0),
            }
        }
        let n = buf.len().min(self.cur.len());
        buf[..n].copy_from_slice(&self.cur[..n]);
        let _ = self.cur.split_to(n);
        Ok(n)
    }
}

async fn put_file(State(st): State<AppState>, headers: HeaderMap, body: Body) -> Response {
    let Some(store) = st.store.clone() else { return disabled() };
    let opts = PutOptions {
        content_type: headers.get("x-content-type").and_then(|v| v.to_str().ok()).map(|s| s.chars().take(255).collect()),
        sample: !headers
            .get("x-reactor-no-sample")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| matches!(v.trim(), "1" | "true")),
    };
    let (tx, rx) = tokio::sync::mpsc::channel(UPLOAD_CHANNEL);
    let task = tokio::task::spawn_blocking(move || store.put_reader(ChannelReader::new(rx), &opts));
    let mut stream = body.into_data_stream();
    while let Some(frame) = stream.next().await {
        let item = frame.map_err(|e| std::io::Error::new(std::io::ErrorKind::ConnectionAborted, e.to_string()));
        let failed = item.is_err();
        if tx.send(item).await.is_err() || failed {
            break; // the writer stopped early (error) or the client aborted
        }
    }
    drop(tx);
    match task.await {
        Ok(Ok(out)) => (StatusCode::OK, Json(out)).into_response(),
        Ok(Err(e)) => store_error(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, format!("store task failed: {}", e)),
    }
}

/// Parsed `Range` header against a representation of `size` bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeSpec {
    Full,
    /// `[start, end)`
    Partial(u64, u64),
    Unsatisfiable,
}

/// RFC 9110 single byte range: `bytes=a-b`, `bytes=a-`, `bytes=-n`. Multiple ranges, other units
/// and syntactically invalid values are ignored (full response), as the RFC permits.
pub fn parse_range(h: Option<&str>, size: u64) -> RangeSpec {
    let Some(h) = h else { return RangeSpec::Full };
    let h = h.trim();
    let Some(spec) = h.get(..6).filter(|p| p.eq_ignore_ascii_case("bytes=")).map(|_| h[6..].trim()) else {
        return RangeSpec::Full;
    };
    if spec.contains(',') {
        return RangeSpec::Full;
    }
    let Some((a, b)) = spec.split_once('-') else { return RangeSpec::Full };
    let (a, b) = (a.trim(), b.trim());
    let num = |s: &str| if !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit()) { s.parse::<u64>().ok() } else { None };
    if a.is_empty() {
        let Some(n) = num(b) else { return RangeSpec::Full };
        if n == 0 || size == 0 {
            return RangeSpec::Unsatisfiable;
        }
        return RangeSpec::Partial(size.saturating_sub(n), size);
    }
    let Some(start) = num(a) else { return RangeSpec::Full };
    let end = if b.is_empty() {
        u64::MAX
    } else {
        match num(b) {
            Some(e) if e >= start => e.saturating_add(1),
            _ => return RangeSpec::Full,
        }
    };
    if start >= size {
        return RangeSpec::Unsatisfiable;
    }
    RangeSpec::Partial(start, end.min(size))
}

async fn get_file(State(st): State<AppState>, method: Method, Path(file_id): Path<String>, headers: HeaderMap) -> Response {
    let Some(store) = st.store.clone() else { return disabled() };
    let Some(id) = parse_id(&file_id) else { return error(StatusCode::BAD_REQUEST, "invalid file id") };
    let s2 = store.clone();
    let meta = match tokio::task::spawn_blocking(move || s2.file_meta(&id)).await {
        Ok(Ok(Some(m))) => m,
        Ok(Ok(None)) => {
            // not held here: data gravity serves it from a holder (NETWORK_SPEC §4)
            return match st.cluster.clone() {
                Some(c) => crate::cluster::remote::serve(c, id, method, &headers).await,
                None => error(StatusCode::NOT_FOUND, "not found"),
            };
        }
        Ok(Err(e)) => return store_error(e),
        Err(e) => return error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let size = meta.size;
    let range = parse_range(headers.get(header::RANGE).and_then(|v| v.to_str().ok()), size);
    let mut h = HeaderMap::new();
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    if let Ok(v) = HeaderValue::from_str(&format!("\"{}\"", file_id.to_ascii_lowercase())) {
        h.insert(header::ETAG, v);
    }
    let (status, start, end) = match range {
        RangeSpec::Full => (StatusCode::OK, 0, size),
        RangeSpec::Partial(s, e) => {
            if let Ok(v) = HeaderValue::from_str(&format!("bytes {}-{}/{}", s, e - 1, size)) {
                h.insert(header::CONTENT_RANGE, v);
            }
            (StatusCode::PARTIAL_CONTENT, s, e)
        }
        RangeSpec::Unsatisfiable => {
            if let Ok(v) = HeaderValue::from_str(&format!("bytes */{}", size)) {
                h.insert(header::CONTENT_RANGE, v);
            }
            h.insert(header::CONTENT_LENGTH, HeaderValue::from(0u64));
            return (StatusCode::RANGE_NOT_SATISFIABLE, h).into_response();
        }
    };
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(end - start));
    if method == Method::HEAD || start == end {
        let mut r = (status, h).into_response();
        // keep the computed Content-Length on HEAD / empty bodies
        *r.body_mut() = Body::empty();
        return r;
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(DOWNLOAD_CHANNEL);
    tokio::task::spawn_blocking(move || {
        let res = store.read_range(&id, start, end, &mut |b| tx.blocking_send(Ok(Bytes::copy_from_slice(b))).is_ok());
        if let Err(e) = res {
            eprintln!("[store] read of {} failed mid-stream: {}", super::id_hex(&id), e);
            let _ = tx.blocking_send(Err(std::io::Error::other(e.to_string())));
        }
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    (status, h, Body::from_stream(stream)).into_response()
}

async fn delete_file(State(st): State<AppState>, Path(file_id): Path<String>) -> Response {
    let Some(store) = st.store.clone() else { return disabled() };
    let Some(id) = parse_id(&file_id) else { return error(StatusCode::BAD_REQUEST, "invalid file id") };
    match tokio::task::spawn_blocking(move || store.delete(&id)).await {
        Ok(Ok(Some(out))) => {
            Json(json!({ "file_id": file_id.to_ascii_lowercase(), "pins": out.pins, "deleted": out.deleted })).into_response()
        }
        Ok(Ok(None)) => {
            // after an origin transfer the pins live on another node: forward the unpin
            if let Some(c) = st.cluster.clone() {
                if let Some(r) = c.forward_unpin(&id).await {
                    return Json(json!({ "file_id": file_id.to_ascii_lowercase(), "pins": r.pins, "deleted": r.deleted, "forwarded_to": r.node_id })).into_response();
                }
            }
            error(StatusCode::NOT_FOUND, "not found")
        }
        Ok(Err(e)) => store_error(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn stats(State(st): State<AppState>) -> Response {
    let Some(store) = st.store.clone() else { return disabled() };
    match tokio::task::spawn_blocking(move || store.stats()).await {
        Ok(Ok(mut v)) => {
            if let Some(c) = &st.cluster {
                v["cluster"] = c.metrics_json();
            }
            Json(v).into_response()
        }
        Ok(Err(e)) => store_error(e),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_parsing() {
        use RangeSpec::*;
        assert_eq!(parse_range(None, 10), Full);
        assert_eq!(parse_range(Some("bytes=0-4"), 10), Partial(0, 5));
        assert_eq!(parse_range(Some("bytes=5-"), 10), Partial(5, 10));
        assert_eq!(parse_range(Some("bytes=5-100"), 10), Partial(5, 10));
        assert_eq!(parse_range(Some("bytes=-3"), 10), Partial(7, 10));
        assert_eq!(parse_range(Some("bytes=-30"), 10), Partial(0, 10));
        assert_eq!(parse_range(Some("BYTES=9-9"), 10), Partial(9, 10));
        assert_eq!(parse_range(Some("bytes=10-"), 10), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=10-20"), 10), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-0"), 10), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=0-0"), 0), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=-5"), 0), Unsatisfiable);
        assert_eq!(parse_range(Some("bytes=5-2"), 10), Full);
        assert_eq!(parse_range(Some("bytes=0-1,4-5"), 10), Full);
        assert_eq!(parse_range(Some("items=0-1"), 10), Full);
        assert_eq!(parse_range(Some("bytes=a-b"), 10), Full);
        assert_eq!(parse_range(Some("bytes=+1-2"), 10), Full);
        assert_eq!(parse_range(Some("bytes="), 10), Full);
    }
}
