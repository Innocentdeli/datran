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
use std::collections::{BTreeMap, HashMap, HashSet};
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
        ObjCache {
            cap,
            bytes: 0,
            tick: 0,
            map: HashMap::new(),
            order: BTreeMap::new(),
        }
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
            let Some((&t, &old)) = self.order.iter().next() else {
                break;
            };
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
        Err(e) => {
            return error(
                StatusCode::BAD_GATEWAY,
                format!("remote read failed: {}", e),
            )
        }
    };
    let size = pm.size;
    let range = parse_range(
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
        size,
    );
    let mut h = HeaderMap::new();
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        HeaderName::from_static("x-reactor-remote"),
        HeaderValue::from_static("1"),
    );
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
    // Pre-determine which unique objects are required for the requested byte range
    let needed_objects: Vec<Id> = {
        let mut list = Vec::new();
        let mut seen = HashSet::new();
        let mut pos = 0u64;
        for c in &pm.chunks {
            let (cs, ce) = (pos, pos + c.len as u64);
            pos = ce;
            if ce <= start {
                continue;
            }
            if cs >= end {
                break;
            }
            if seen.insert(c.object_id) {
                list.push(c.object_id);
            }
        }
        list
    };

    let concurrency = std::env::var("REACTOR_REMOTE_CONCURRENCY")
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(4usize)
        .max(1);

    let (obj_tx, mut obj_rx) =
        tokio::sync::mpsc::channel::<(Id, Result<Arc<Vec<u8>>, String>)>(concurrency);
    {
        let cluster = cluster.clone();
        let holders = holders.clone();
        tokio::spawn(async move {
            use futures_util::StreamExt;
            let mut stream = futures_util::stream::iter(needed_objects.into_iter().map(|oid| {
                let cl = cluster.clone();
                let h = holders.clone();
                async move {
                    let res = cl.object_plain(&oid, &h).await;
                    (oid, res)
                }
            }))
            .buffered(concurrency);

            while let Some(item) = stream.next().await {
                let is_err = item.1.is_err();
                if obj_tx.send(item).await.is_err() || is_err {
                    break;
                }
            }
        });
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::spawn(async move {
        let mut pos = 0u64;
        let mut sent = 0u64;
        let mut active_objects: HashMap<Id, Arc<Vec<u8>>> = HashMap::new();

        for c in &pm.chunks {
            let (cs, ce) = (pos, pos + c.len as u64);
            pos = ce;
            if ce <= start {
                continue;
            }
            if cs >= end {
                break;
            }
            let plain = if let Some(p) = active_objects.get(&c.object_id) {
                p.clone()
            } else if let Some(p) = cluster.cached_object(&c.object_id) {
                active_objects.insert(c.object_id, p.clone());
                p
            } else {
                let mut found = None;
                while let Some((oid, res)) = obj_rx.recv().await {
                    match res {
                        Ok(p) => {
                            let is_target = oid == c.object_id;
                            active_objects.insert(oid, p.clone());
                            if is_target {
                                found = Some(p);
                                break;
                            }
                        }
                        Err(e) => {
                            tracing::warn!("remote read of {} failed: {}", id_hex(&id), e);
                            let _ = tx.send(Err(std::io::Error::other(e))).await;
                            return;
                        }
                    }
                }
                match found {
                    Some(p) => p,
                    None => match cluster.object_plain(&c.object_id, &holders).await {
                        Ok(p) => {
                            active_objects.insert(c.object_id, p.clone());
                            p
                        }
                        Err(e) => {
                            tracing::warn!("remote read of {} failed: {}", id_hex(&id), e);
                            let _ = tx.send(Err(std::io::Error::other(e))).await;
                            return;
                        }
                    },
                }
            };
            let (os, oe) = (
                c.object_offset as usize,
                c.object_offset as usize + c.len as usize,
            );
            if oe > plain.len() || sha256(&plain[os..oe]) != c.id {
                let _ = tx
                    .send(Err(std::io::Error::other(format!(
                        "chunk {} failed SHA-256 verification",
                        id_hex(&c.id)
                    ))))
                    .await;
                return;
            }
            let a = os + (start.max(cs) - cs) as usize;
            let b = os + (end.min(ce) - cs) as usize;
            if tx
                .send(Ok(Bytes::copy_from_slice(&plain[a..b])))
                .await
                .is_err()
            {
                break;
            }
            sent += (b - a) as u64;
        }
        cluster
            .metrics
            .remote_read_bytes
            .fetch_add(sent, Ordering::Relaxed);
    });
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item, rx))
    });
    (status, h, Body::from_stream(stream)).into_response()
}
