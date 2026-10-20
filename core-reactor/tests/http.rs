mod common;

use common::*;
use core_reactor::evolution::Engine;
use core_reactor::gossip::{Gossip, GossipConfig};
use core_reactor::server::{router, AppState};
use serde_json::Value;
use std::sync::Arc;

async fn start(token: Option<&str>) -> (String, Arc<Engine>, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(Engine::new(test_config(dir.path(), 1)));
    let state = AppState {
        engine: engine.clone(),
        gossip: Arc::new(Gossip::new(GossipConfig::disabled())),
        reactor_token: token.map(|t| Arc::new(t.as_bytes().to_vec())),
        max_output: 64 << 20,
        store: None,
        cluster: None,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    (format!("http://{}", addr), engine, dir)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compress_decompress_status_over_http() {
    let (url, engine, _dir) = start(Some("tok")).await;
    let c = reqwest::Client::new();
    assert_eq!(
        c.get(format!("{}/health", url))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        c.post(format!("{}/compress", url))
            .body("x")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        c.get(format!("{}/evolution/status", url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );

    let json = json_logs(50_000, 1);
    let r = c
        .post(format!("{}/compress", url))
        .header("x-reactor-token", "tok")
        .header("x-content-type", "application/json")
        .body(json.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let h = r.headers().clone();
    for k in [
        "x-datran-algo",
        "x-datran-ratio",
        "x-datran-time-us",
        "x-datran-entropy",
    ] {
        assert!(h.get(k).is_some(), "missing {}", k);
    }
    assert_eq!(h["x-reactor-class"], "text/json");
    assert_eq!(h["x-reactor-format"], "v2");
    assert_eq!(h["x-original-size"], json.len().to_string().as_str());
    let recipe: Value = serde_json::from_str(h["x-reactor-recipe"].to_str().unwrap()).unwrap();
    assert_eq!(recipe["codec"], "zstd");
    let blob = r.bytes().await.unwrap();
    assert_eq!(h["x-compressed-size"], blob.len().to_string().as_str());
    assert!(blob.len() < json.len() / 3);
    let back = c
        .post(format!("{}/decompress", url))
        .header("x-reactor-token", "tok")
        .body(blob)
        .send()
        .await
        .unwrap();
    assert_eq!(back.bytes().await.unwrap().to_vec(), json);

    // random => legacy raw, recipe null; no-sample honored
    let rnd = random_bytes(10_000, 2);
    let r = c
        .post(format!("{}/compress", url))
        .header("x-reactor-token", "tok")
        .header("x-reactor-no-sample", "1")
        .body(rnd.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(r.headers()["x-reactor-recipe"], "null");
    assert_eq!(r.headers()["x-reactor-format"], "legacy-raw");
    let blob = r.bytes().await.unwrap();
    assert_eq!(blob[0], 0x02);
    let back = c
        .post(format!("{}/decompress", url))
        .header("x-reactor-token", "tok")
        .body(blob)
        .send()
        .await
        .unwrap();
    assert_eq!(back.bytes().await.unwrap().to_vec(), rnd);

    let r = c
        .post(format!("{}/compress", url))
        .header("x-reactor-token", "tok")
        .header("x-reactor-no-sample", "1")
        .body(json_logs(10_000, 3))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert_eq!(engine.sample_count("text/json"), 1);

    // bad blob => 400
    let r = c
        .post(format!("{}/decompress", url))
        .header("x-reactor-token", "tok")
        .body(vec![0x10, 9, 9])
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 400);

    let st: Value = c
        .get(format!("{}/evolution/status", url))
        .header("x-reactor-token", "tok")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(st["classes"]
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["class"] == "text/json" && c["samples"] == 1));
    assert!(st["weights"]["encode"].is_number() && st["weights"]["decode"].is_number());
    assert!(st["peers"].is_array());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metrics_auth_request_ids_and_series() {
    use core_reactor::server::{router_with, MetricsAuth};
    let dir = tempfile::tempdir().unwrap();
    let engine = Arc::new(Engine::new(test_config(dir.path(), 1)));
    let state = AppState {
        engine: engine.clone(),
        gossip: Arc::new(Gossip::new(GossipConfig::disabled())),
        reactor_token: Some(Arc::new(b"tok".to_vec())),
        max_output: 64 << 20,
        store: None,
        cluster: None,
    };
    let auth = MetricsAuth {
        token: Some(Arc::new(b"mtok".to_vec())),
        public: false,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move {
        axum::serve(listener, router_with(state, auth))
            .await
            .unwrap()
    });
    let c = reqwest::Client::new();

    // request ids: a valid client id is echoed, a bad one replaced, none generated
    let r = c
        .get(format!("{}/health", url))
        .header("x-request-id", "abc-123")
        .send()
        .await
        .unwrap();
    assert_eq!(r.headers()["x-request-id"], "abc-123");
    let r = c
        .get(format!("{}/health", url))
        .header("x-request-id", "bad id with spaces")
        .send()
        .await
        .unwrap();
    assert_eq!(r.headers()["x-request-id"].len(), 32);
    let r = c.get(format!("{}/health", url)).send().await.unwrap();
    assert_eq!(r.headers()["x-request-id"].len(), 32);

    let json = json_logs(20_000, 4);
    let r = c
        .post(format!("{}/compress", url))
        .header("x-reactor-token", "tok")
        .body(json)
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);

    // never unauthenticated; either token works; wrong tokens do not
    assert_eq!(
        c.get(format!("{}/metrics", url))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        c.get(format!("{}/metrics", url))
            .bearer_auth("nope")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        c.get(format!("{}/metrics", url))
            .header("x-reactor-token", "mtok")
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        c.get(format!("{}/metrics", url))
            .header("x-reactor-token", "tok")
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    let r = c
        .get(format!("{}/metrics", url))
        .bearer_auth("mtok")
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    assert!(r.headers()["content-type"]
        .to_str()
        .unwrap()
        .starts_with("text/plain"));
    let body = r.text().await.unwrap();
    for needle in [
        "reactor_http_requests_total{method=\"POST\",route=\"/compress\",status=\"200\"}",
        "reactor_http_request_duration_seconds_bucket",
        "reactor_codec_bytes_total{codec=\"zstd\",op=\"compress\"}",
        "reactor_codec_bytes_total{codec=\"zstd\",op=\"verify\"}",
        "reactor_evolution_generation",
        "reactor_profile{profile=\"balanced\"} 1",
        "reactor_up 1",
    ] {
        assert!(body.contains(needle), "missing {}\n{}", needle, body);
    }
    // route templates only: no raw ids / paths with ids in labels
    assert!(!body.contains("route=\"/store/files/"), "{}", body);

    // no token configured anywhere and not public => still refused
    let dir2 = tempfile::tempdir().unwrap();
    let state = AppState {
        engine: Arc::new(Engine::new(test_config(dir2.path(), 1))),
        gossip: Arc::new(Gossip::new(GossipConfig::disabled())),
        reactor_token: None,
        max_output: 64 << 20,
        store: None,
        cluster: None,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url2 = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router(state)).await.unwrap() });
    assert_eq!(
        c.get(format!("{}/metrics", url2))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
}
