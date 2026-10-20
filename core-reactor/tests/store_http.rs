//! `/store/*` HTTP endpoints (NETWORK_SPEC §2).

mod common;

use common::*;
use core_reactor::evolution::Engine;
use core_reactor::gossip::{Gossip, GossipConfig};
use core_reactor::server::{router, AppState};
use core_reactor::store::{sha256, Store, StoreConfig};
use serde_json::Value;
use std::sync::Arc;

async fn start(max_bytes: Option<u64>) -> (String, Arc<Store>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut ec = test_config(&dir.path().join("evo"), 1);
    ec.persist = false;
    let engine = Arc::new(Engine::new(ec));
    let mut cfg = StoreConfig::new(dir.path().join("store"));
    cfg.max_bytes = max_bytes;
    let store = Arc::new(Store::open(cfg, engine.clone()).unwrap());
    let state = AppState {
        engine,
        gossip: Arc::new(Gossip::new(GossipConfig::disabled())),
        reactor_token: Some(Arc::new(b"tok".to_vec())),
        max_output: 64 << 20,
        store: Some(store.clone()),
        cluster: None,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    (format!("http://{}", addr), store, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn store_endpoints() {
    let (url, store, _dir) = start(None).await;
    let c = reqwest::Client::new();
    let tok = |r: reqwest::RequestBuilder| r.header("x-reactor-token", "tok");

    // auth
    assert_eq!(
        c.put(format!("{}/store/files", url))
            .body("x")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        c.get(format!("{}/store/stats", url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    // PUT
    let data = json_logs(3_000_000, 5);
    let r = tok(c.put(format!("{}/store/files", url)))
        .header("x-content-type", "application/json")
        .header("x-reactor-no-sample", "1")
        .body(data.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    let fid = hex::encode(sha256(&data));
    assert_eq!(v["file_id"], fid);
    assert_eq!(v["size"], data.len() as u64);
    assert!(v["new_chunks"].as_u64().unwrap() > 10);
    assert_eq!(v["dedup_chunks"], 0);
    assert!(v["stored_bytes"].as_u64().unwrap() < data.len() as u64 / 3);
    assert_eq!(v["class"], "text/json");
    assert_eq!(v["pins"], 1);
    assert_eq!(
        store.engine.sample_count("text/json"),
        0,
        "x-reactor-no-sample honored"
    );

    // GET full (streamed)
    let r = tok(c.get(format!("{}/store/files/{}", url, fid)))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(r.headers()["accept-ranges"], "bytes");
    assert_eq!(
        r.headers()["content-length"],
        data.len().to_string().as_str()
    );
    assert_eq!(r.headers()["etag"], format!("\"{}\"", fid).as_str());
    assert_eq!(r.bytes().await.unwrap().to_vec(), data);

    // HEAD
    let r = tok(c.head(format!("{}/store/files/{}", url, fid)))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(
        r.headers()["content-length"],
        data.len().to_string().as_str()
    );
    assert_eq!(r.headers()["accept-ranges"], "bytes");

    // ranges
    let n = data.len();
    for (hdr, s, e) in [
        ("bytes=0-0", 0, 1),
        ("bytes=100-200099", 100, 200_100),
        (&*format!("bytes={}-", n - 10), n - 10, n),
        ("bytes=-1000", n - 1000, n),
        (&*format!("bytes=5-{}", n * 2), 5, n),
    ] {
        let r = tok(c.get(format!("{}/store/files/{}", url, fid)))
            .header("range", hdr)
            .send()
            .await
            .unwrap();
        assert_eq!(r.status(), 206, "{}", hdr);
        assert_eq!(
            r.headers()["content-range"],
            format!("bytes {}-{}/{}", s, e - 1, n).as_str()
        );
        assert_eq!(r.headers()["content-length"], (e - s).to_string().as_str());
        assert_eq!(r.bytes().await.unwrap().to_vec(), &data[s..e], "{}", hdr);
    }
    let r = tok(c.get(format!("{}/store/files/{}", url, fid)))
        .header("range", format!("bytes={}-", n))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 416);
    assert_eq!(
        r.headers()["content-range"],
        format!("bytes */{}", n).as_str()
    );
    let r = tok(c.get(format!("{}/store/files/{}", url, fid)))
        .header("range", "bytes=0-1,5-6")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200, "multi-range ignored");

    // duplicate PUT -> pin 2; DELETE twice
    let r = tok(c.put(format!("{}/store/files", url)))
        .body(data.clone())
        .send()
        .await
        .unwrap();
    let v: Value = r.json().await.unwrap();
    assert_eq!(
        (
            v["pins"].as_u64(),
            v["dedup_chunks"].as_u64(),
            v["stored_bytes"].as_u64()
        ),
        (Some(2), v["chunks"].as_u64(), Some(0))
    );

    // empty file
    let r = tok(c.put(format!("{}/store/files", url)))
        .body(Vec::<u8>::new())
        .send()
        .await
        .unwrap();
    let v: Value = r.json().await.unwrap();
    let empty_id = v["file_id"].as_str().unwrap().to_string();
    let r = tok(c.get(format!("{}/store/files/{}", url, empty_id)))
        .send()
        .await
        .unwrap();
    assert_eq!(
        (
            r.status().as_u16(),
            r.headers()["content-length"].to_str().unwrap().to_string()
        ),
        (200, "0".into())
    );
    let r = tok(c.get(format!("{}/store/files/{}", url, empty_id)))
        .header("range", "bytes=0-")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 416);

    // stats
    let v: Value = tok(c.get(format!("{}/store/stats", url)))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(v["files"], 2);
    assert_eq!(v["logical_bytes"], n as u64);
    assert!(v["physical_bytes"].as_u64().unwrap() > 0);
    for k in [
        "dedup_ratio",
        "compression_ratio",
        "objects",
        "super_chunks",
    ] {
        assert!(v[k].is_number(), "stats.{}", k);
    }
    for k in ["queue_objects", "grace_ms"] {
        assert!(v["gc"][k].is_number(), "stats.gc.{}", k);
    }
    for k in ["fusions", "bytes_saved", "reads_saved"] {
        assert!(v["fusion"][k].is_number(), "stats.fusion.{}", k);
    }
    assert!(v["scrub"]["objects_checked"].is_number());

    // DELETE (unpin)
    let r = tok(c.delete(format!("{}/store/files/{}", url, fid)))
        .send()
        .await
        .unwrap();
    let v: Value = r.json().await.unwrap();
    assert_eq!(
        (v["pins"].as_u64(), v["deleted"].as_bool()),
        (Some(1), Some(false))
    );
    let v: Value = tok(c.delete(format!("{}/store/files/{}", url, fid)))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        (v["pins"].as_u64(), v["deleted"].as_bool()),
        (Some(0), Some(true))
    );
    assert_eq!(
        tok(c.get(format!("{}/store/files/{}", url, fid)))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        tok(c.head(format!("{}/store/files/{}", url, fid)))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        tok(c.delete(format!("{}/store/files/{}", url, fid)))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
    assert_eq!(
        tok(c.get(format!("{}/store/files/not-hex", url)))
            .send()
            .await
            .unwrap()
            .status(),
        400
    );
    assert!(store.verify_index(true).unwrap().ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn store_full_returns_507_and_concurrent_uploads() {
    let (url, store, _dir) = start(Some(2_000_000)).await;
    let c = reqwest::Client::new();
    let put = |body: Vec<u8>| {
        let c = c.clone();
        let url = url.clone();
        async move {
            c.put(format!("{}/store/files", url))
                .header("x-reactor-token", "tok")
                .body(body)
                .send()
                .await
                .unwrap()
        }
    };
    // 6 concurrent uploads of the same content + 2 distinct ones
    let same = text(800_000, 1);
    let mut tasks = Vec::new();
    for i in 0..8u64 {
        let body = if i < 6 {
            same.clone()
        } else {
            json_logs(300_000, i)
        };
        tasks.push(tokio::spawn(put(body)));
    }
    for t in tasks {
        assert_eq!(t.await.unwrap().status(), 200);
    }
    assert_eq!(store.file_meta(&sha256(&same)).unwrap().unwrap().pins, 6);
    let r = put(random_bytes(3_000_000, 9)).await;
    assert_eq!(r.status(), 507);
    let v: Value = r.json().await.unwrap();
    assert_eq!(v["error"], "store full");
    assert!(
        store.verify_index(true).unwrap().ok(),
        "rejected upload left no debris"
    );
}
