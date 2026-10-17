mod common;

use axum::routing::get;
use axum::Json;
use common::*;
use core_reactor::classify::{BINARY_NUMERIC, TEXT_JSON};
use core_reactor::codec::{Codec, Filter};
use core_reactor::evolution::{score_recipe, Engine};
use core_reactor::gossip::{parse_peers, Gossip, GossipConfig};
use core_reactor::recipe::Recipe;
use core_reactor::server::{check_bind, router, AppState};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;

const TOKEN: &str = "cluster-secret";

fn gossip_cfg(peers: Vec<String>, token: Option<&str>, share: bool) -> GossipConfig {
    GossipConfig {
        peers,
        cluster_token: token.map(String::from),
        interval: Duration::from_secs(3600),
        share_dicts: share,
        timeout: Duration::from_secs(10),
    }
}

async fn serve(app: axum::Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{}", addr)
}

async fn start(engine: Arc<Engine>, cfg: GossipConfig) -> (String, AppState) {
    let state = AppState { engine, gossip: Arc::new(Gossip::new(cfg)), reactor_token: None, max_output: 64 << 20, store: None, cluster: None };
    (serve(router(state.clone())).await, state)
}

fn feed(engine: &Engine, docs: &[Vec<u8>]) {
    for d in docs {
        engine.compress(d, None, true);
    }
}

async fn get_status(client: &reqwest::Client, url: &str, token: Option<&str>) -> u16 {
    let mut rq = client.get(url);
    if let Some(t) = token {
        rq = rq.header("x-cluster-token", t);
    }
    rq.send().await.unwrap().status().as_u16()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn node_b_adopts_immigrant_from_a_and_scores_locally() {
    let (da, db) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
    let a = Arc::new(ratio_only_engine(da.path(), 100));
    let b = Arc::new(ratio_only_engine(db.path(), 200));
    let a_docs: Vec<Vec<u8>> = (0..6).map(|i| f32_sensor(8_000, 10 + i)).collect();
    let b_docs: Vec<Vec<u8>> = (0..6).map(|i| f32_sensor(8_000, 50 + i)).collect();
    feed(&a, &a_docs);
    feed(&b, &b_docs);
    let ea = a.clone();
    tokio::task::spawn_blocking(move || {
        for _ in 0..4 {
            ea.run_generation(BINARY_NUMERIC);
        }
    })
    .await
    .unwrap();
    let a_champ = a.champion(BINARY_NUMERIC).unwrap();

    let (a_url, _) = start(a.clone(), gossip_cfg(vec![], Some(TOKEN), false)).await;
    let (_, b_state) = start(b.clone(), gossip_cfg(vec![a_url.clone()], Some(TOKEN), false)).await;

    // champions endpoint
    let client = reqwest::Client::new();
    let list: Value = client
        .get(format!("{}/evolution/champions", a_url))
        .header("x-cluster-token", TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list[0]["class"], BINARY_NUMERIC);
    assert_eq!(Recipe::from_json_value(&list[0]["recipe"]).unwrap(), a_champ.recipe);

    let added = b_state.gossip.pull_once(&b).await;
    let in_b_pop = b.population(BINARY_NUMERIC).iter().any(|m| m.recipe == a_champ.recipe);
    assert!(added == 1 || in_b_pop, "added {}", added);
    assert_eq!(b.pending_immigrants(BINARY_NUMERIC).contains(&a_champ.recipe), added == 1);
    let peers = b_state.gossip.peer_status();
    assert!(peers[0].last_ok.is_some() && peers[0].last_error.is_none());

    let eb = b.clone();
    let report = tokio::task::spawn_blocking(move || eb.run_generation(BINARY_NUMERIC).unwrap()).await.unwrap();
    let scored = report.scored.iter().find(|m| m.recipe == a_champ.recipe).expect("immigrant scored");
    let local = score_recipe(
        &a_champ.recipe,
        &b_docs.iter().skip(1).step_by(2).map(|d| Arc::new(d.clone())).collect::<Vec<_>>(),
        None,
        0.0,
        0.0,
        64 << 20,
    )
    .unwrap();
    assert!((scored.score.as_ref().unwrap().fitness - local.fitness).abs() < 1e-12);
    assert!((local.fitness - a_champ.score.fitness).abs() > 1e-9, "B must use its own samples");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn peer_scores_are_not_trusted_and_invalid_recipes_dropped() {
    let fake = axum::Router::new().route(
        "/evolution/champions",
        get(|| async {
            Json(json!([
                { "class": "binary/numeric", "recipe": {"codec":"lz4","level":0,"window_log":null,"filter":"delta","stride":8,"dict":null}, "fitness": 1e9 },
                { "class": "binary/numeric", "recipe": {"codec":"zstd","level":99}, "fitness": 1e9 },
                { "class": "binary/numeric", "recipe": {"codec":"zstd","level":5,"dict":"ab".repeat(32)}, "fitness": 1e9 },
                { "class": "media/compressed", "recipe": {"codec":"zstd","level":5}, "fitness": 1e9 },
                { "class": "../../etc", "recipe": {"codec":"zstd","level":5}, "fitness": 1e9 },
                "garbage"
            ]))
        }),
    );
    let fake_url = serve(fake).await;
    let d = tempfile::tempdir().unwrap();
    let b = Arc::new(ratio_only_engine(d.path(), 3));
    feed(&b, &(0..4).map(|i| f32_sensor(8_000, i)).collect::<Vec<_>>());
    let g = Gossip::new(gossip_cfg(vec![fake_url], Some(TOKEN), false));
    assert_eq!(g.pull_once(&b).await, 1);
    let imm = Recipe::new(Codec::Lz4, 0).with_filter(Filter::Delta, 8);
    assert_eq!(b.pending_immigrants(BINARY_NUMERIC), vec![imm.clone()]);
    let eb = b.clone();
    let r = tokio::task::spawn_blocking(move || eb.run_generation(BINARY_NUMERIC).unwrap()).await.unwrap();
    assert_ne!(r.champion.unwrap().recipe, imm, "a weak immigrant must not win on reported fitness");
    let m = r.scored.iter().find(|m| m.recipe == imm).unwrap();
    assert!(m.score.as_ref().unwrap().fitness < 10.0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wrong_or_missing_cluster_token_rejected() {
    let d = tempfile::tempdir().unwrap();
    let a = Arc::new(ratio_only_engine(d.path(), 1));
    let (a_url, _) = start(a.clone(), gossip_cfg(vec![], Some(TOKEN), true)).await;
    let client = reqwest::Client::new();
    let champs = format!("{}/evolution/champions", a_url);
    assert_eq!(get_status(&client, &champs, None).await, 401);
    assert_eq!(get_status(&client, &champs, Some("nope")).await, 401);
    assert_eq!(get_status(&client, &champs, Some(TOKEN)).await, 200);
    let dict = format!("{}/evolution/dict/{}", a_url, "00".repeat(32));
    assert_eq!(get_status(&client, &dict, Some("nope")).await, 401);

    let db = tempfile::tempdir().unwrap();
    let b = Arc::new(ratio_only_engine(db.path(), 2));
    let g = Gossip::new(gossip_cfg(vec![a_url.clone()], Some("wrong"), false));
    assert_eq!(g.pull_once(&b).await, 0);
    let st = g.peer_status();
    assert!(st[0].last_error.as_deref().unwrap_or("").contains("401"), "{:?}", st);
    assert!(st[0].last_ok.is_none());

    // gossip disabled without a cluster token
    let dc = tempfile::tempdir().unwrap();
    let (c_url, _) = start(Arc::new(ratio_only_engine(dc.path(), 3)), gossip_cfg(vec![], None, false)).await;
    assert_eq!(get_status(&client, &format!("{}/evolution/champions", c_url), Some(TOKEN)).await, 404);
    let g = Gossip::new(gossip_cfg(vec![a_url], None, false));
    assert!(!g.enabled());
    assert_eq!(g.pull_once(&b).await, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dictionaries_shared_only_when_enabled() {
    // A: small JSON corpus => trained dictionary champion
    let da = tempfile::tempdir().unwrap();
    let a = Arc::new(ratio_only_engine(da.path(), 5));
    feed(&a, &(0..40).map(small_json).collect::<Vec<_>>());
    let ea = a.clone();
    tokio::task::spawn_blocking(move || ea.run_generation(TEXT_JSON).unwrap()).await.unwrap();
    let champ = a.champion(TEXT_JSON).unwrap().recipe;
    let dict_hex = champ.dict.clone().expect("dict champion");
    let blob = a.compress(&small_json(777), None, false).blob;
    assert_eq!(blob[0], 0x10);

    let (a_private, _) = start(a.clone(), gossip_cfg(vec![], Some(TOKEN), false)).await;
    let (a_shared, _) = start(a.clone(), gossip_cfg(vec![], Some(TOKEN), true)).await;
    let client = reqwest::Client::new();

    // sharing disabled: no dict endpoint, champion offered without dict
    assert_eq!(get_status(&client, &format!("{}/evolution/dict/{}", a_private, dict_hex), Some(TOKEN)).await, 404);
    let list: Value = client
        .get(format!("{}/evolution/champions", a_private))
        .header("x-cluster-token", TOKEN)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(list.as_array().unwrap().iter().all(|e| e["recipe"]["dict"].is_null()), "{}", list);

    // B with sharing disabled cannot decode the dict blob, even from a sharing peer
    let db = tempfile::tempdir().unwrap();
    let b = Arc::new(ratio_only_engine(db.path(), 6));
    let (b_url, b_state) = start(b.clone(), gossip_cfg(vec![a_shared.clone()], Some(TOKEN), false)).await;
    b_state.gossip.pull_once(&b).await;
    assert!(b.pending_immigrants(TEXT_JSON).iter().all(|r| r.dict.is_none()));
    let resp = client.post(format!("{}/decompress", b_url)).body(blob.clone()).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 400);
    let err: Value = resp.json().await.unwrap();
    assert_eq!(err["unknown_dict"], dict_hex);
    assert!(!db.path().join("dicts").join(format!("{}.dict", dict_hex)).exists());

    // C with sharing enabled: /decompress fetches the dict from A, verifies and stores it
    let dc = tempfile::tempdir().unwrap();
    let c = Arc::new(ratio_only_engine(dc.path(), 7));
    let (c_url, _) = start(c.clone(), gossip_cfg(vec![a_shared.clone()], Some(TOKEN), true)).await;
    let resp = client.post(format!("{}/decompress", c_url)).body(blob.clone()).send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert_eq!(resp.bytes().await.unwrap().to_vec(), small_json(777));
    assert!(dc.path().join("dicts").join(format!("{}.dict", dict_hex)).exists());

    // D with sharing enabled pulls the dict champion and its dictionary via gossip
    let dd = tempfile::tempdir().unwrap();
    let dnode = Arc::new(ratio_only_engine(dd.path(), 8));
    let g = Gossip::new(gossip_cfg(vec![a_shared], Some(TOKEN), true));
    assert_eq!(g.pull_once(&dnode).await, 1);
    assert_eq!(dnode.pending_immigrants(TEXT_JSON), vec![champ.clone()]);
    assert!(dnode.dicts.contains(&champ.dict_id().unwrap()));
}

#[test]
fn bind_rules_and_peer_parsing() {
    let lo: std::net::IpAddr = "127.0.0.1".parse().unwrap();
    let lo6: std::net::IpAddr = "::1".parse().unwrap();
    let any: std::net::IpAddr = "0.0.0.0".parse().unwrap();
    assert!(check_bind(lo, false, false).is_ok());
    assert!(check_bind(lo6, false, false).is_ok());
    assert!(check_bind(any, false, false).is_err());
    assert!(check_bind(any, true, false).is_err());
    assert!(check_bind(any, false, true).is_err());
    assert!(check_bind(any, true, true).is_ok());
    assert_eq!(
        parse_peers(" http://a:1/ , ftp://x, https://b ,,"),
        vec!["http://a:1".to_string(), "https://b".to_string()]
    );
}
