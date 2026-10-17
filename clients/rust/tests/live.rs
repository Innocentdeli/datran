mod common;

use bytes::Bytes;
use datran_client::{ByteRange, Client, ErrorKind, UploadOptions};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::time::Duration;

fn client(r: &common::Reactor) -> Client {
    let mut b = Client::builder(&r.url).timeout(Duration::from_secs(30));
    if let Some(t) = &r.token {
        b = b.token(t);
    }
    b.build().unwrap()
}

macro_rules! reactor_or_skip {
    () => {
        match common::start() {
            Some(r) => r,
            None => return,
        }
    };
}

/// Returns false (and logs SKIPPED) when `/store/stats` answers 404 (no store) or 503 (store disabled).
async fn store_available(c: &Client) -> bool {
    match c.store_stats().await {
        Ok(_) => true,
        Err(e) if e.is_not_found() || e.status() == Some(503) => {
            eprintln!("SKIPPED: store not available on this reactor (/store/stats -> {:?})", e.status());
            false
        }
        Err(e) => panic!("store_stats: {}", e),
    }
}

fn sha_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

#[tokio::test]
async fn health_and_entropy() {
    let r = reactor_or_skip!();
    let c = client(&r);
    let h = c.health().await.unwrap();
    assert_eq!(h.status, "online");
    assert!(!h.features.is_empty());
    let e = c.entropy(&b"hello"[..]).await.unwrap();
    assert_eq!(e.size_bytes, 5);
    assert!((e.entropy_bits - 1.92).abs() < 0.01);
    assert_eq!(e.suggested_routing, "symbit");
}

#[tokio::test]
async fn compress_roundtrip_and_status() {
    let r = reactor_or_skip!();
    let c = client(&r);
    let data = common::sample_text(5000);
    let out = c.compress(data.clone(), &UploadOptions::content_type("application/json")).await.unwrap();
    assert_eq!(out.meta.original_size, data.len() as u64);
    assert_eq!(out.meta.compressed_size, out.data.len() as u64);
    assert!(out.data.len() < data.len());
    assert_eq!(out.meta.format, "v2");
    assert!(out.meta.recipe.is_some());
    assert!(!out.meta.content_class.is_empty());
    assert!(out.meta.ratio > 1.0);
    assert_eq!(c.decompress(out.data.clone()).await.unwrap(), Bytes::from(data));

    let s = c.evolution_status().await.unwrap();
    assert!(s.interval_ms > 0);
    assert!(!s.classes.is_empty());
}

#[tokio::test]
async fn streaming_compress_decompress() {
    let r = reactor_or_skip!();
    let c = client(&r);
    let data = common::sample_text(20000);
    let chunks: Vec<Result<Bytes, std::io::Error>> = data.chunks(10_000).map(|c| Ok(Bytes::copy_from_slice(c))).collect();
    let body = datran_client::Body::wrap_stream(futures_util::stream::iter(chunks));
    let (meta, mut s) = c.compress_stream(body, &UploadOptions::default().no_sample()).await.unwrap();
    let mut blob = Vec::new();
    while let Some(b) = s.next().await {
        blob.extend_from_slice(&b.unwrap());
    }
    assert_eq!(blob.len() as u64, meta.compressed_size);
    let mut s = c.decompress_stream(blob).await.unwrap();
    let mut back = Vec::new();
    while let Some(b) = s.next().await {
        back.extend_from_slice(&b.unwrap());
    }
    assert_eq!(back, data);
}

#[tokio::test]
async fn empty_random_and_errors() {
    let r = reactor_or_skip!();
    let c = client(&r);
    let e = c.compress(Vec::new(), &UploadOptions::default()).await.unwrap();
    assert!(c.decompress(e.data).await.unwrap().is_empty());
    let rnd = common::random_bytes(50_000, 7);
    let out = c.compress(rnd.clone(), &UploadOptions::default()).await.unwrap();
    assert_eq!(out.meta.content_class, "media/compressed");
    assert!(out.meta.recipe.is_none());
    assert_eq!(out.meta.format, "legacy-raw");
    assert_eq!(c.decompress(out.data).await.unwrap(), Bytes::from(rnd));

    let err = c.decompress(&b"\x67garbage"[..]).await.unwrap_err();
    assert_eq!(err.status(), Some(400));
    assert_eq!(err.kind(), Some(ErrorKind::BadRequest));
    assert!(err.api().unwrap().message.to_lowercase().contains("flag"));

    if r.token.is_some() {
        let bad = Client::new(&r.url, Some("wrong-token")).unwrap();
        let err = bad.entropy(&b"x"[..]).await.unwrap_err();
        assert_eq!(err.kind(), Some(ErrorKind::Unauthorized));
        assert_eq!(bad.health().await.unwrap().status, "online");
    }
}

#[tokio::test]
async fn transport_error_on_refused_connection() {
    let c = Client::builder("http://127.0.0.1:9").max_retries(1).backoff(Duration::from_millis(1)).build().unwrap();
    let e = c.health().await.unwrap_err();
    assert!(matches!(e, datran_client::Error::Transport(_)), "{e:?}");
}

#[tokio::test]
async fn store_put_get_range_delete() {
    let r = reactor_or_skip!();
    let c = client(&r);
    if !store_available(&c).await {
        return;
    }
    let mut data = common::sample_text(30000);
    data.extend(common::random_bytes(100_000, 42));
    let fid = sha_hex(&data);
    let put = c.store_put(data.clone(), &UploadOptions::content_type("application/json")).await.unwrap();
    assert_eq!(put.file_id, fid);
    assert_eq!(put.size, data.len() as u64);
    assert!(!put.duplicate);
    assert_eq!(put.pins, 1);
    assert!(put.chunks > 0);
    assert_eq!(put.new_chunks + put.dedup_chunks, put.chunks);
    assert!(put.stored_bytes > 0);
    assert!(put.new_bytes > 0 && put.new_bytes <= put.size);
    assert!(!put.class.is_empty());

    let etag = format!("\"{}\"", fid);
    let full = c.store_get(&fid, None).await.unwrap();
    assert_eq!(full.info.status, 200);
    assert_eq!(&full.data[..], &data[..]);
    assert_eq!(full.info.etag.as_deref(), Some(etag.as_str()));

    let h = c.store_head(&fid).await.unwrap();
    assert_eq!(h.size, data.len() as u64);
    assert_eq!(h.accept_ranges.as_deref(), Some("bytes"));
    assert_eq!(h.etag.as_deref(), Some(etag.as_str()));
    assert!(c.store_exists(&fid.to_uppercase()).await.unwrap());

    let g = c.store_get(&fid, Some(ByteRange::Span(1000, 1999))).await.unwrap();
    assert_eq!(g.info.status, 206);
    assert_eq!(&g.data[..], &data[1000..2000]);
    assert_eq!((g.info.start, g.info.end, g.info.total), (1000, Some(1999), Some(data.len() as u64)));
    let s = c.store_get(&fid, Some(ByteRange::Suffix(777))).await.unwrap();
    assert_eq!(&s.data[..], &data[data.len() - 777..]);
    let f = c.store_get(&fid, Some(ByteRange::From(data.len() as u64 - 10))).await.unwrap();
    assert_eq!(&f.data[..], &data[data.len() - 10..]);
    let e = c.store_get(&fid, Some(ByteRange::From(data.len() as u64 + 10))).await.unwrap_err();
    assert_eq!(e.kind(), Some(ErrorKind::RangeNotSatisfiable));
    assert_eq!(e.api().unwrap().range_total(), Some(data.len() as u64));

    let mut sink = Vec::new();
    let (_, n) = c.store_get_to_writer(&fid, None, &mut sink).await.unwrap();
    assert_eq!(n, data.len() as u64);
    assert_eq!(sha_hex(&sink), fid);

    let d = c.store_delete(&fid).await.unwrap();
    assert_eq!((d.file_id.as_str(), d.pins, d.deleted), (fid.as_str(), 0, true));
    assert!(c.store_get(&fid, None).await.unwrap_err().is_not_found());
    assert!(!c.store_exists(&fid).await.unwrap());
    assert!(c.store_delete(&fid).await.unwrap_err().is_not_found());
}

#[tokio::test]
async fn store_put_file_chunked_dedup_pins_stats() {
    let r = reactor_or_skip!();
    let c = client(&r);
    if !store_available(&c).await {
        return;
    }
    // A per-run tag on every line keeps every chunk unique, so the first put stores all of it.
    let tag = format!("\"{:x}-user", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
    let data = String::from_utf8(common::sample_text(8000)).unwrap().replace("\"user", &tag).into_bytes();
    let fid = sha_hex(&data);
    let path = std::env::temp_dir().join(format!("datran-rs-up-{}.json", std::process::id()));
    std::fs::write(&path, &data).unwrap();
    let a = c.store_put_file(&path, &UploadOptions::default()).await.unwrap();
    std::fs::remove_file(&path).ok();
    // Unknown length -> chunked transfer encoding.
    let reader = std::io::Cursor::new(data.clone());
    let b = c.store_put_reader(reader, None, &UploadOptions::default()).await.unwrap();
    assert_eq!(a.file_id, fid);
    assert_eq!(b.file_id, fid);
    assert_eq!(b.new_chunks, 0);
    assert!(b.dedup_chunks > 0);
    assert_eq!(b.dedup_chunks, b.chunks);
    assert!(b.duplicate);
    assert_eq!((a.pins, b.pins), (1, 2));
    // new_bytes: plaintext of newly stored chunks; compression = new_bytes / stored_bytes
    assert_eq!((a.new_chunks, a.new_bytes), (a.chunks, data.len() as u64));
    assert!(a.new_bytes > a.stored_bytes, "JSON lines compress");
    assert_eq!((b.new_bytes, b.stored_bytes), (0, 0));
    let d1 = c.store_delete(&fid).await.unwrap(); // one pin left
    assert_eq!((d1.pins, d1.deleted), (1, false));
    assert_eq!(&c.store_get(&fid, None).await.unwrap().data[..], &data[..]);
    let d2 = c.store_delete(&fid).await.unwrap();
    assert_eq!((d2.pins, d2.deleted), (0, true));
    assert!(c.store_head(&fid).await.unwrap_err().is_not_found());

    // Typed stats while a file is stored.
    let before = c.store_stats().await.unwrap();
    let small = common::sample_text(3000);
    let p = c.store_put(small.clone(), &UploadOptions::default()).await.unwrap();
    let s = c.store_stats().await.unwrap();
    assert!(s.files >= 1);
    assert!(s.puts > before.puts);
    assert!(s.logical_bytes >= small.len() as u64);
    assert!(s.unique_bytes > 0 && s.live_physical_bytes > 0 && s.chunks > 0);
    assert_eq!(s.max_bytes, None);
    assert!(s.dedup_ratio >= 1.0 && s.total_ratio > 0.0);
    assert!(s.gc.grace_ms > 0);
    assert!(s.fusion.coaccess_min > 0.0);
    assert!(s.group_commit.as_ref().is_some_and(|g| g.jobs >= 1));
    assert_eq!(s.cluster, None); // single reactor without REACTOR_CLUSTER_TOKEN
    let nc = Client::builder(&r.url).token(r.token.clone().unwrap_or_default()).max_retries(0).build().unwrap();
    assert_eq!(nc.cluster_status().await.unwrap_err().status(), Some(503));
    c.store_delete(&p.file_id).await.unwrap();

    assert!(c.store_get(&"0".repeat(64), None).await.unwrap_err().is_not_found());
    // Well-formed path segment but not a SHA-256 -> 400 "invalid file id".
    assert_eq!(c.store_get(&"zz".repeat(32), None).await.unwrap_err().status(), Some(400));
}

async fn wait_healthy(c: &Client, peer: &str) -> Option<datran_client::ClusterStatus> {
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while std::time::Instant::now() < deadline {
        let s = c.cluster_status().await.unwrap();
        if s.peer(peer).is_some_and(|p| p.healthy) {
            return Some(s);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

#[tokio::test]
async fn cluster_two_nodes_remote_read_forwarded_delete_and_admin() {
    let Some(cl) = common::start_cluster(2, 200) else { return };
    let (a, b) = (client(&cl.nodes[0]), client(&cl.nodes[1]));
    let a_id = a.cluster_status().await.unwrap().node_id;
    let b_id = b.cluster_status().await.unwrap().node_id;
    assert_ne!(a_id, b_id);
    let sa = wait_healthy(&a, &b_id).await.expect("A never saw B healthy");
    wait_healthy(&b, &a_id).await.expect("B never saw A healthy");
    assert_eq!((sa.cluster_size, sa.min_replicas, sa.min_replicas_effective, sa.gossip_interval_ms), (2, 1, 1, 200));
    let pb = sa.peer(&b_id).unwrap();
    assert_eq!(pb.url, cl.nodes[1].url);
    assert!(!pb.is_self && pb.consecutive_failures == 0 && pb.last_ok_ms.is_some());

    let mut data = common::sample_text(4000);
    data.extend(common::random_bytes(20_000, 9));
    let fid = sha_hex(&data);
    assert_eq!(a.store_put(data.clone(), &UploadOptions::default()).await.unwrap().file_id, fid);
    let g = b.store_get(&fid, None).await.unwrap(); // remote read from A
    assert_eq!(&g.data[..], &data[..]);
    assert_eq!(&b.store_get(&fid, Some(ByteRange::Span(100, 199))).await.unwrap().data[..], &data[100..200]);
    let st = b.store_stats().await.unwrap();
    let m = st.cluster.expect("cluster metrics in /store/stats");
    assert!(m.remote_reads >= 1 && m.remote_read_bytes > 0);

    // ClusterAdmin against A
    let adm = datran_client::ClusterAdmin::new(&cl.nodes[0].url, &cl.cluster_token).unwrap();
    let inv = adm.inventory(None, None).await.unwrap();
    assert!(inv.full && inv.added.contains(&fid) && inv.node_id == a_id);
    let delta = adm.inventory(Some(inv.version), Some(inv.now_ms)).await.unwrap();
    assert!(!delta.full && delta.added.is_empty() && delta.version == inv.version);
    let h = adm.hold(&fid, "sdktest", false, 0).await.unwrap();
    assert!(h.granted && h.expires_ms > 0 && !h.origin_accepted);
    let refused = adm.hold(&"0".repeat(64), "sdktest", false, 0).await.unwrap();
    assert_eq!((refused.granted, refused.reason.as_deref()), (false, Some("not held")));
    let bad = datran_client::ClusterAdmin::new(&cl.nodes[0].url, "wrong").unwrap();
    assert_eq!(bad.inventory(None, None).await.unwrap_err().kind(), Some(ErrorKind::Unauthorized));

    // B does not hold the file: the unpin is forwarded to A (origin)
    let d = b.store_delete(&fid).await.unwrap();
    assert_eq!((d.pins, d.deleted, d.forwarded_to.as_deref()), (0, true, Some(a_id.as_str())));
    assert!(a.store_get(&fid, None).await.unwrap_err().is_not_found());
    drop(cl);
}
