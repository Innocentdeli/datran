//! Data gravity (NETWORK_SPEC §4): multi-node clusters in one process, ephemeral ports, temp
//! dirs. Background loops are not started; tests drive maintenance rounds explicitly so they are
//! deterministic.

mod common;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::IntoResponse;
use common::*;
use core_reactor::cluster::tls::{self, TlsSettings};
use core_reactor::cluster::{Cluster, ClusterConfig, PullReason};
use core_reactor::evolution::Engine;
use core_reactor::gossip::{Gossip, GossipConfig};
use core_reactor::server::{router, AppState};
use core_reactor::store::{id_hex, sha256, Id, Store, StoreConfig};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

const CTOK: &str = "cluster-secret";
const RTOK: &str = "reactor-secret";

struct Node {
    url: String,
    store: Arc<Store>,
    cluster: Arc<Cluster>,
    down: Arc<AtomicBool>,
    _dir: tempfile::TempDir,
}

#[derive(Clone, Default)]
struct Opts {
    max_bytes: Option<u64>,
    tls: Option<TlsSettings>,
    tls_ca: Option<std::path::PathBuf>,
    token: Option<String>,
    min_replicas: Option<usize>,
}

struct Pending {
    listener: tokio::net::TcpListener,
    url: String,
}

async fn bind(https: bool) -> Pending {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let scheme = if https { "https" } else { "http" };
    Pending { listener, url: format!("{}://{}", scheme, addr) }
}

async fn start(p: Pending, peers: Vec<String>, o: Opts) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let mut ec = test_config(&dir.path().join("evo"), 1);
    ec.persist = false;
    let engine = Arc::new(Engine::new(ec));
    let mut sc = StoreConfig::new(dir.path().join("store"));
    sc.max_bytes = o.max_bytes;
    let store = Arc::new(Store::open(sc, engine.clone()).unwrap());
    let mut cc = ClusterConfig::new(dir.path()).unwrap();
    cc.peers = peers;
    cc.cluster_token = Some(o.token.clone().unwrap_or_else(|| CTOK.to_string()));
    cc.interval = Duration::from_secs(3600);
    cc.peer_timeout = Duration::from_secs(3600);
    cc.request_timeout = Duration::from_secs(10);
    cc.min_replicas = o.min_replicas.unwrap_or(2);
    cc.tls_ca = o.tls_ca.clone();
    cc.tls_server = o.tls.is_some();
    let cluster = Cluster::start(cc, store.clone()).unwrap();
    let state = AppState {
        engine,
        gossip: Arc::new(Gossip::new(GossipConfig::disabled())),
        reactor_token: Some(Arc::new(RTOK.as_bytes().to_vec())),
        max_output: 64 << 20,
        store: Some(store.clone()),
        cluster: Some(cluster.clone()),
    };
    let down = Arc::new(AtomicBool::new(false));
    let d = down.clone();
    // simulated node failure: every request answers 503 while `down` is set
    let app = router(state).layer(axum::middleware::from_fn(move |req: Request, next: Next| {
        let d = d.clone();
        async move {
            if d.load(Ordering::SeqCst) {
                (axum::http::StatusCode::SERVICE_UNAVAILABLE, "down").into_response()
            } else {
                next.run(req).await
            }
        }
    }));
    let tls_cfg = o.tls.clone();
    tokio::spawn(async move { tls::serve(p.listener, app, tls_cfg, std::future::pending()).await.unwrap() });
    Node { url: p.url, store, cluster, down, _dir: dir }
}

/// `n` plain-HTTP nodes, each with every other node as a peer.
async fn cluster_of(n: usize, opts: &[Opts]) -> Vec<Node> {
    let mut pend = Vec::new();
    for _ in 0..n {
        pend.push(bind(false).await);
    }
    let urls: Vec<String> = pend.iter().map(|p| p.url.clone()).collect();
    let mut nodes = Vec::new();
    for (i, p) in pend.into_iter().enumerate() {
        let peers = urls.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, u)| u.clone()).collect();
        nodes.push(start(p, peers, opts.get(i).cloned().unwrap_or_default()).await);
    }
    nodes
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(30)).build().unwrap()
}

async fn put(n: &Node, data: &[u8]) -> reqwest::Response {
    client()
        .put(format!("{}/store/files", n.url))
        .header("x-reactor-token", RTOK)
        .header("x-reactor-no-sample", "1")
        .body(data.to_vec())
        .send()
        .await
        .unwrap()
}

async fn put_ok(n: &Node, data: &[u8]) -> Id {
    let r = put(n, data).await;
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    core_reactor::store::parse_id(v["file_id"].as_str().unwrap()).unwrap()
}

async fn get(n: &Node, id: &Id, range: Option<&str>) -> (u16, Vec<u8>, reqwest::header::HeaderMap) {
    let mut rq = client().get(format!("{}/store/files/{}", n.url, id_hex(id))).header("x-reactor-token", RTOK);
    if let Some(r) = range {
        rq = rq.header("range", r);
    }
    let r = rq.send().await.unwrap();
    let status = r.status().as_u16();
    let headers = r.headers().clone();
    (status, r.bytes().await.unwrap().to_vec(), headers)
}

fn metric(n: &Node, k: &str) -> u64 {
    n.cluster.metrics_json()[k].as_u64().unwrap()
}

fn holds(n: &Node, id: &Id) -> bool {
    n.store.contains_file(id).unwrap()
}

async fn gossip_all(nodes: &[&Node]) {
    for n in nodes {
        if !n.down.load(Ordering::SeqCst) {
            n.cluster.gossip_round().await;
        }
    }
}

async fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("timed out waiting for {}", what);
}

/// Distinct objects holding the chunks that overlap `[s, e)` of `id` on `n`.
fn objects_for_range(n: &Node, id: &Id, s: u64, e: u64) -> usize {
    let refs = n.store.chunk_refs(id).unwrap().unwrap().1;
    let mut objs: Vec<Id> = refs.iter().filter(|r| r.file_offset < e && r.file_offset + r.len as u64 > s).map(|r| r.object_id).collect();
    objs.dedup();
    objs.len()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn remote_read_gravity_pull_and_leased_drop() {
    let nodes = cluster_of(3, &[]).await;
    let (a, b, c) = (&nodes[0], &nodes[1], &nodes[2]);
    let data = random_bytes(1_500_000, 7);
    let fid = put_ok(a, &data).await;
    assert_eq!(fid, sha256(&data));

    // remote range read on C fetches only the objects overlapping the range
    let (s, e) = (300_000u64, 420_000u64);
    let need = objects_for_range(a, &fid, s, e) as u64;
    let (st, body, h) = get(c, &fid, Some(&format!("bytes={}-{}", s, e - 1))).await;
    assert_eq!(st, 206);
    assert_eq!(h["x-reactor-remote"], "1");
    assert_eq!(body, &data[s as usize..e as usize]);
    assert_eq!(metric(c, "remote_objects_fetched"), need, "range read fetched only the needed objects");
    let total = a.store.chunk_refs(&fid).unwrap().unwrap().1.len() as u64;
    assert!(total > need + 5);

    // full remote read: exact bytes; cached objects are not fetched again
    let (st, body, _) = get(c, &fid, None).await;
    assert_eq!((st, body.len()), (200, data.len()));
    assert!(body == data, "remote read returns exact bytes");
    assert_eq!(metric(c, "remote_objects_fetched"), total);
    assert!(metric(c, "cache_hits") >= need);
    assert!(!holds(c, &fid));

    // third request reaches REACTOR_GRAVITY_PULL (3) -> C pulls a replica
    let (st, _, _) = get(c, &fid, Some("bytes=0-99")).await;
    assert_eq!(st, 206);
    wait_for("gravity pull on C", || holds(c, &fid)).await;
    assert_eq!(metric(c, "pulls"), 1);
    let cm = c.store.file_meta(&fid).unwrap().unwrap();
    assert!(!cm.origin && cm.pins == 0, "replicas are not origin and carry no pins");
    assert_eq!(c.store.read_to_vec(&fid, None).unwrap(), data);
    assert!(c.store.verify_index(true).unwrap().ok());

    // A is cold, C is hot, but only one other holder: no drop (min replicas 2)
    gossip_all(&[a, b, c]).await;
    assert!(a.cluster.peer_demand(&fid) >= 2.5);
    assert_eq!(a.cluster.drop_pass().await, 0);
    assert!(holds(a, &fid));

    // B gets a replica too; but B is unreachable when A asks for its lease: no lease, no drop
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    gossip_all(&[a, b, c]).await;
    assert_eq!(a.cluster.holders(&fid).len(), 2);
    b.down.store(true, Ordering::SeqCst);
    assert_eq!(a.cluster.drop_pass().await, 0);
    assert!(holds(a, &fid), "a refused/failed lease prevents the drop");
    b.down.store(false, Ordering::SeqCst);

    // both leases granted; A is the pinned origin -> origin moves to C (most demand), then drop
    assert_eq!(a.cluster.drop_pass().await, 1);
    assert!(!holds(a, &fid));
    let cm = c.store.file_meta(&fid).unwrap().unwrap();
    assert!(cm.origin && cm.pins == 1, "origin transferred with its pins: {:?}", cm);
    assert!(!b.store.file_meta(&fid).unwrap().unwrap().origin);
    assert_eq!((metric(a, "drops"), metric(a, "origin_transfers")), (1, 1));
    assert!(b.cluster.has_active_lease(&fid) && c.cluster.has_active_lease(&fid), "holders promised to keep it");
    // holders under lease never gravity-drop it
    assert_eq!(b.cluster.drop_pass().await + c.cluster.drop_pass().await, 0);

    // A can still serve it remotely
    gossip_all(&[a, b, c]).await;
    let (st, body, _) = get(a, &fid, None).await;
    assert!(st == 200 && body == data);

    // DELETE on A (no longer holder) is forwarded to the new origin; the tombstone propagates
    let r = client().delete(format!("{}/store/files/{}", a.url, id_hex(&fid))).header("x-reactor-token", RTOK).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let v: Value = r.json().await.unwrap();
    assert_eq!((v["deleted"].as_bool(), v["forwarded_to"].as_str()), (Some(true), Some(c.cluster.cfg.node_id.as_str())));
    assert!(!holds(c, &fid));
    gossip_all(&[b]).await;
    assert!(!holds(b, &fid), "tombstone removed B's replica");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn repair_after_node_loss_without_stampede() {
    let nodes = cluster_of(4, &[]).await;
    let all: Vec<&Node> = nodes.iter().collect();
    let a = &nodes[0];
    let data = text(400_000, 3);
    let fid = put_ok(a, &data).await;
    gossip_all(&all).await;

    // under-replicated (1 < 2): every node runs repair concurrently, exactly one pulls
    let pulls: Vec<usize> = futures_util::future::join_all(all.iter().map(|n| n.cluster.repair_pass())).await;
    assert_eq!(pulls.iter().sum::<usize>(), 1, "{:?}", pulls);
    let expected = nodes[1..].iter().min_by(|x, y| x.cluster.cfg.node_id.cmp(&y.cluster.cfg.node_id)).unwrap();
    assert!(holds(expected, &fid), "leader = most free capacity, tie-break smallest node_id");
    assert_eq!(nodes.iter().filter(|n| holds(n, &fid)).count(), 2);

    // a second round does nothing
    gossip_all(&all).await;
    let pulls: Vec<usize> = futures_util::future::join_all(all.iter().map(|n| n.cluster.repair_pass())).await;
    assert_eq!(pulls.iter().sum::<usize>(), 0);

    // kill the replica holder
    expected.down.store(true, Ordering::SeqCst);
    let alive: Vec<&Node> = nodes.iter().filter(|n| !n.down.load(Ordering::SeqCst)).collect();
    gossip_all(&alive).await;
    assert!(alive.iter().all(|n| n.cluster.status()["peers"].as_array().unwrap().iter().any(|p| p["healthy"] == false)));
    let before: u64 = alive.iter().map(|n| metric(n, "pulls")).sum();
    let pulls: Vec<usize> = futures_util::future::join_all(alive.iter().map(|n| n.cluster.repair_pass())).await;
    assert_eq!(pulls.iter().sum::<usize>(), 1, "no duplicate stampede: {:?}", pulls);
    assert_eq!(alive.iter().map(|n| metric(n, "pulls")).sum::<u64>(), before + 1);
    let holders = alive.iter().filter(|n| holds(n, &fid)).count();
    assert_eq!(holders, 2, "replica count restored among live nodes");
    let new_leader = alive.iter().filter(|n| n.url != a.url).min_by(|x, y| x.cluster.cfg.node_id.cmp(&y.cluster.cfg.node_id)).unwrap();
    assert!(holds(new_leader, &fid));
    assert_eq!(metric(new_leader, "repairs"), 1);
    assert_eq!(new_leader.store.read_to_vec(&fid, None).unwrap(), data);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tombstones_propagate_and_old_replicas_do_not_resurrect() {
    let nodes = cluster_of(3, &[]).await;
    let (a, b, c) = (&nodes[0], &nodes[1], &nodes[2]);
    let data = json_logs(500_000, 4);
    let fid = put_ok(a, &data).await;
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    assert!(c.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    gossip_all(&[a, b, c]).await;

    // C is offline while the origin deletes the file
    c.down.store(true, Ordering::SeqCst);
    let r = client().delete(format!("{}/store/files/{}", a.url, id_hex(&fid))).header("x-reactor-token", RTOK).send().await.unwrap();
    assert_eq!(r.json::<Value>().await.unwrap()["deleted"], true);
    assert!(a.store.tombstone(&fid).unwrap().is_some());
    gossip_all(&[b]).await;
    assert!(!holds(b, &fid), "every holder deletes the file");
    assert_eq!(metric(b, "tombstones_applied"), 1);

    // C rejoins with its stale replica: nobody re-replicates it, nobody serves it
    c.down.store(false, Ordering::SeqCst);
    gossip_all(&[a, b]).await;
    assert_eq!(a.cluster.holders(&fid).len(), 1, "C still advertises its old replica");
    assert_eq!(a.cluster.repair_pass().await + b.cluster.repair_pass().await, 0);
    assert!(!holds(a, &fid) && !holds(b, &fid), "tombstone beats the older replica");
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.is_err());
    assert_eq!(get(b, &fid, None).await.0, 404);
    // C learns the tombstone and deletes its replica
    gossip_all(&[c]).await;
    assert!(!holds(c, &fid));
    assert!(c.store.tombstone(&fid).unwrap().is_some());

    // a re-upload after the delete is newer than the tombstone and survives gossip
    tokio::time::sleep(Duration::from_millis(5)).await;
    let fid2 = put_ok(a, &data).await;
    assert_eq!(fid2, fid);
    gossip_all(&[a, b, c]).await;
    assert!(holds(a, &fid));
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap(), "newer manifest beats the tombstone");
    gossip_all(&[c, b, a]).await;
    assert!(holds(a, &fid) && holds(b, &fid));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn corrupt_object_is_quarantined_and_repaired_from_peer() {
    let nodes = cluster_of(2, &[]).await;
    let (a, b) = (&nodes[0], &nodes[1]);
    let data = text(600_000, 9);
    let fid = put_ok(a, &data).await;
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    gossip_all(&[a, b]).await;

    let oid = b.store.chunk_refs(&fid).unwrap().unwrap().1[2].object_id;
    let hex = id_hex(&oid);
    // the object is small, so it lives in a pack: flip bytes inside its record
    let at = b.store.object_storage(&oid).unwrap().unwrap();
    assert!(at.pack.is_some(), "small objects are packed");
    let mut raw = std::fs::read(&at.path).unwrap();
    let mid = (at.offset + at.len / 2) as usize;
    raw[mid] ^= 0xff;
    raw[mid + 1] ^= 0x55;
    std::fs::write(&at.path, &raw).unwrap();

    let s = b.store.clone();
    let rep = tokio::task::spawn_blocking(move || s.scrub_step(u64::MAX)).await.unwrap().unwrap();
    assert_eq!(rep.corrupt, vec![hex.clone()], "scrub quarantines the corrupt object");
    wait_for("quarantine repair", || metric(b, "quarantine_repairs") == 1).await;
    assert!(b.store.quarantined().unwrap().is_empty());
    assert!(!b.store.object_meta(&oid).unwrap().unwrap().quarantined);
    assert_eq!(b.store.read_to_vec(&fid, None).unwrap(), data);
    assert!(b.store.verify_index(true).unwrap().ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cluster_auth_and_wire_shapes() {
    let mut pend = vec![bind(false).await, bind(false).await];
    let (pb, pa) = (pend.pop().unwrap(), pend.pop().unwrap());
    let (ua, ub) = (pa.url.clone(), pb.url.clone());
    let a = start(pa, vec![ub.clone()], Opts::default()).await;
    let b = start(pb, vec![ua.clone()], Opts { token: Some("wrong-token".into()), ..Default::default() }).await;
    let data = text(200_000, 1);
    let fid = put_ok(&a, &data).await;
    let c = client();

    // x-cluster-token: missing / wrong -> 401; right -> 200
    assert_eq!(c.get(format!("{}/cluster/inventory", ua)).send().await.unwrap().status(), 401);
    for path in ["/cluster/inventory", &format!("/cluster/manifests/{}", id_hex(&fid))] {
        let r = c.get(format!("{}{}", ua, path)).header("x-cluster-token", "wrong-token").send().await.unwrap();
        assert_eq!(r.status(), 401, "{}", path);
    }
    let r = c.post(format!("{}/cluster/hold/{}", ua, id_hex(&fid))).header("x-cluster-token", "cluster-secreT").send().await.unwrap();
    assert_eq!(r.status(), 401);
    // the reactor token is not a cluster token
    let r = c.get(format!("{}/cluster/inventory", ua)).header("x-cluster-token", RTOK).send().await.unwrap();
    assert_eq!(r.status(), 401);

    // a node configured with the wrong token cannot gossip and sees the peer unhealthy
    b.cluster.gossip_round().await;
    let st = b.cluster.status();
    assert_eq!(st["peers"][0]["healthy"], false);
    assert!(st["peers"][0]["last_error"].as_str().unwrap().contains("401"));
    assert_eq!(get(&b, &fid, None).await.0, 502, "remote read is refused too");

    // inventory shape
    let inv: Value = c.get(format!("{}/cluster/inventory?since=0", ua)).header("x-cluster-token", CTOK).send().await.unwrap().json().await.unwrap();
    for k in ["node_id", "version", "full", "more", "used", "added", "removed", "tombstones", "demand", "now_ms"] {
        assert!(!inv[k].is_null(), "inventory.{}", k);
    }
    assert!(inv["capacity"].is_null() && inv["region"].is_null());
    assert_eq!(inv["full"], true);
    assert_eq!(inv["added"], serde_json::json!([id_hex(&fid)]));
    let v = inv["version"].as_u64().unwrap();
    let delta: Value = c
        .get(format!("{}/cluster/inventory?since={}", ua, v))
        .header("x-cluster-token", CTOK)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!((delta["full"].as_bool(), delta["added"].as_array().unwrap().len()), (Some(false), 0));

    // local GETs record demand (store read hook)
    assert_eq!(a.cluster.demand(&fid), 0.0);
    assert_eq!(get(&a, &fid, None).await.1, data);
    assert!((a.cluster.demand(&fid) - 1.0).abs() < 0.01);
    let inv: Value = c.get(format!("{}/cluster/inventory?since=0", ua)).header("x-cluster-token", CTOK).send().await.unwrap().json().await.unwrap();
    assert_eq!(inv["demand"][0]["file_id"], id_hex(&fid));

    // hold shape
    let h: Value = c
        .post(format!("{}/cluster/hold/{}?node=abc", ua, id_hex(&fid)))
        .header("x-cluster-token", CTOK)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(h["granted"], true);
    assert_eq!(h["lease_ms"], 600_000);
    assert_eq!(h["origin_accepted"], false);
    assert!(h["expires_ms"].as_u64().unwrap() > 0 && h["node_id"] == a.cluster.cfg.node_id.as_str() && h["reason"].is_null());
    let h: Value = c
        .post(format!("{}/cluster/hold/{}", ua, "00".repeat(32)))
        .header("x-cluster-token", CTOK)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!((h["granted"].as_bool(), h["reason"].as_str()), (Some(false), Some("not held")));

    // status needs the reactor token
    assert_eq!(c.get(format!("{}/cluster/status", ua)).send().await.unwrap().status(), 401);
    assert_eq!(c.get(format!("{}/cluster/status", ua)).header("x-cluster-token", CTOK).send().await.unwrap().status(), 401);
    let st: Value = c.get(format!("{}/cluster/status", ua)).header("x-reactor-token", RTOK).send().await.unwrap().json().await.unwrap();
    for k in ["node_id", "region", "tls", "cluster_size", "min_replicas", "min_replicas_effective", "peers", "holders_sample", "demand_top", "metrics"] {
        assert!(st.get(k).is_some(), "status.{}", k);
    }
    assert_eq!(st["holders_sample"][0]["holders"], serde_json::json!([a.cluster.cfg.node_id]));
    for k in ["pulls", "drops", "repairs", "remote_read_bytes", "leases_active"] {
        assert!(st["metrics"][k].is_number(), "status.metrics.{}", k);
    }
    let stats: Value = c.get(format!("{}/store/stats", ua)).header("x-reactor-token", RTOK).send().await.unwrap().json().await.unwrap();
    assert!(stats["cluster"]["pulls"].is_number(), "/store/stats carries the gravity metrics");
}

fn make_ca_and_leaf(dir: &std::path::Path) -> (std::path::PathBuf, TlsSettings) {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(rcgen::DnType::CommonName, "datran test CA");
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let leaf_key = KeyPair::generate().unwrap();
    let leaf_params = CertificateParams::new(vec!["127.0.0.1".to_string(), "localhost".to_string()]).unwrap();
    let leaf = leaf_params.signed_by(&leaf_key, &ca, &ca_key).unwrap();
    let ca_path = dir.join("ca.pem");
    std::fs::write(&ca_path, ca.pem()).unwrap();
    std::fs::write(dir.join("cert.pem"), leaf.pem()).unwrap();
    std::fs::write(dir.join("key.pem"), leaf_key.serialize_pem()).unwrap();
    (ca_path, TlsSettings { cert: dir.join("cert.pem"), key: dir.join("key.pem") })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tls_between_peers() {
    let certs = tempfile::tempdir().unwrap();
    let (ca, tls_files) = make_ca_and_leaf(certs.path());
    let pa = bind(true).await;
    let ua = pa.url.clone();
    let a = start(pa, vec![], Opts { tls: Some(tls_files), ..Default::default() }).await;
    let b = start(bind(false).await, vec![ua.clone()], Opts { tls_ca: Some(ca.clone()), ..Default::default() }).await;
    let c = start(bind(false).await, vec![ua.clone()], Opts::default()).await;

    let data = json_logs(300_000, 2);
    let r = reqwest::Client::builder()
        .tls_certs_only(reqwest::Certificate::from_pem_bundle(&std::fs::read(&ca).unwrap()).unwrap())
        .build()
        .unwrap()
        .put(format!("{}/store/files", ua))
        .header("x-reactor-token", RTOK)
        .body(data.clone())
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
    let fid = sha256(&data);

    b.cluster.gossip_round().await;
    assert_eq!(b.cluster.status()["peers"][0]["healthy"], true, "{}", b.cluster.status()["peers"][0]);
    assert_eq!(b.cluster.holders(&fid).len(), 1);
    let (st, body, _) = get(&b, &fid, None).await;
    assert!(st == 200 && body == data, "remote read over TLS");
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    assert_eq!(b.store.read_to_vec(&fid, None).unwrap(), data);

    // without the CA the peer's certificate is not trusted
    c.cluster.gossip_round().await;
    assert_eq!(c.cluster.status()["peers"][0]["healthy"], false);
    assert!(a.cluster.status()["tls"].as_bool().unwrap());
    // plain HTTP to the TLS port fails
    let plain = client().get(format!("{}/health", ua.replace("https://", "http://"))).send().await;
    assert!(!plain.map(|r| r.status().is_success()).unwrap_or(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn eviction_never_drops_below_min_replicas() {
    let opts = [Opts::default(), Opts { max_bytes: Some(1_600_000), ..Default::default() }, Opts::default()];
    let nodes = cluster_of(3, &opts).await;
    let (a, b, c) = (&nodes[0], &nodes[1], &nodes[2]);
    let x = random_bytes(1_000_000, 11);
    let fx = put_ok(a, &x).await;
    assert!(b.cluster.pull(&fx, PullReason::Manual).await.unwrap());
    gossip_all(&[a, b, c]).await;

    // B is nearly full; its only cold replica has a single other holder -> nothing evictable
    let y = random_bytes(800_000, 12);
    let r = put(b, &y).await;
    assert_eq!(r.status(), 507, "eviction would drop X below 2 replicas");
    assert!(holds(b, &fx));

    // once C holds X too, B may evict it (after A and C granted leases)
    assert!(c.cluster.pull(&fx, PullReason::Manual).await.unwrap());
    gossip_all(&[a, b, c]).await;
    let fy = put_ok(b, &y).await;
    assert!(holds(b, &fy) && !holds(b, &fx));
    assert!(holds(a, &fx) && holds(c, &fx), "X still has 2 replicas");
    assert!(a.cluster.has_active_lease(&fx) && c.cluster.has_active_lease(&fx));
    assert!(metric(b, "evictions_confirmed") >= 1);
    assert!(b.store.verify_index(false).unwrap().ok());

    // now X is at exactly 2 replicas and leased: C cannot evict or drop it either
    assert_eq!(c.cluster.drop_pass().await, 0);
}
