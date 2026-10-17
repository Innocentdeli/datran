//! Remote reads (NETWORK_SPEC §4 "Remote read"): `GET /store/files/:id` for a file this node
//! does not hold. The manifest comes from a holder; only the objects overlapping the requested
//! range are fetched (raw blob, decoded locally, object hash = plaintext SHA-256 checked) and every
//! chunk's SHA-256 is verified before its bytes are sent. A failing holder is skipped for the
//! next one. Decoded objects go into a bounded LRU cache (not the store); the read counts as
//! demand and may trigger a gravity pull.

use super::{Cluster, PullReason};
use crate::store::http::{parse_range, RangeSpec};
use crate::store::{id_hex, sha256, Id};
use axum::{
    body::{Body, Bytes},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Json, Response},
};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::Ordering;
use std::sync::Arc;

/// Bounded LRU of decoded, verified object plaintexts.
pub struct ObjCache {
    cap: u64,
    bytes: u64,
    tick: u64,
    map: HashMap<Id, (Arc<Vec<u8>>, u64)>,
    order: BTreeMap<u64, Id>,
}

impl ObjCache {
    pub fn new(cap: u64) -> ObjCache {
        ObjCache { cap, bytes: 0, tick: 0, map: HashMap::new(), order: BTreeMap::new() }
    }

    pub fn get(&mut self, id: &Id) -> Option<Arc<Vec<u8>>> {
        self.tick += 1;
        let tick = self.tick;
        let (v, t) = self.map.get_mut(id)?;
        self.order.remove(t);
        *t = tick;
        self.order.insert(tick, *id);
        Some(v.clone())
    }

    pub fn put(&mut self, id: Id, v: Arc<Vec<u8>>) {
        let len = v.len() as u64;
        if len > self.cap || self.map.contains_key(&id) {
            return;
        }
        while self.bytes + len > self.cap {
            let Some((&t, &old)) = self.order.iter().next() else { break };
            self.order.remove(&t);
            if let Some((ov, _)) = self.map.remove(&old) {
                self.bytes -= ov.len() as u64;
            }
        }
        self.tick += 1;
        self.order.insert(self.tick, id);
        self.map.insert(id, (v, self.tick));
        self.bytes += len;
    }

    /// `(bytes, objects)`.
    pub fn usage(&self) -> (u64, usize) {
        (self.bytes, self.map.len())
    }
}

fn error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(serde_json::json!({ "error": msg.into() }))).into_response()
}

/// Serves a GET/HEAD for a file that is not stored locally.
pub async fn serve(cluster: Arc<Cluster>, id: Id, method: Method, headers: &HeaderMap) -> Response {
    let (pm, holders) = match cluster.fetch_manifest(&id).await {
        Ok(Some(x)) => x,
        Ok(None) => return error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => return error(StatusCode::BAD_GATEWAY, format!("remote read failed: {}", e)),
    };
    let size = pm.size;
    let range = parse_range(headers.get(header::RANGE).and_then(|v| v.to_str().ok()), size);
    let mut h = HeaderMap::new();
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
    h.insert(HeaderName::from_static("x-reactor-remote"), HeaderValue::from_static("1"));
    if let Ok(v) = HeaderValue::from_str(&format!("\"{}\"", id_hex(&id))) {
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
    if method == Method::HEAD {
        let mut r = (status, h).into_response();
        *r.body_mut() = Body::empty();
        return r;
    }
    cluster.metrics.remote_reads.fetch_add(1, Ordering::Relaxed);
    if cluster.should_pull(cluster.record_demand(&id)) {
        cluster.spawn_pull(id, PullReason::Gravity);
    }
    if start == end {
        let mut r = (status, h).into_response();
        *r.body_mut() = Body::empty();
        return r;
    }
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::spawn(async move {
        let mut pos = 0u64;
        let mut sent = 0u64;
        for c in &pm.chunks {
            let (cs, ce) = (pos, pos + c.len as u64);
            pos = ce;
            if ce <= start {
                continue;
            }
            if cs >= end {
                break;
            }
            let plain = match cluster.object_plain(&c.object_id, &holders).await {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("[cluster] remote read of {} failed: {}", id_hex(&id), e);
                    let _ = tx.send(Err(std::io::Error::other(e))).await;
                    return;
                }
            };
            let (os, oe) = (c.object_offset as usize, c.object_offset as usize + c.len as usize);
            if oe > plain.len() || sha256(&plain[os..oe]) != c.id {
                let _ = tx.send(Err(std::io::Error::other(format!("chunk {} failed SHA-256 verification", id_hex(&c.id))))).await;
                return;
            }
            let a = os + (start.max(cs) - cs) as usize;
            let b = os + (end.min(ce) - cs) as usize;
            if tx.send(Ok(Bytes::copy_from_slice(&plain[a..b]))).await.is_err() {
                break;
            }
            sent += (b - a) as u64;
        }
        cluster.metrics.remote_read_bytes.fetch_add(sent, Ordering::Relaxed);
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
    (status, h, Body::from_stream(stream)).into_response()
}
