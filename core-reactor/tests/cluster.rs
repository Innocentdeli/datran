//! Data gravity (NETWORK_SPEC §4): multi-node clusters in one process, ephemeral ports, temp
//! dirs. Background loops are not started; tests drive maintenance rounds explicitly so they are
//! deterministic.
//!
//! Every multi-node scenario runs twice: over plain HTTP and over QUIC (HTTP/3, TLS 1.3 with a
//! test CA, peers given as `quic://127.0.0.1:<port>`; the QUIC listener uses the UDP port with
//! the same number as the node's HTTPS port). QUIC-specific behaviour (mTLS, fallback, 0-RTT,
//! loss) is tested at the end.

mod common;

use axum::extract::Request;
use axum::middleware::Next;
use axum::response::IntoResponse;
use common::*;
use core_reactor::cluster::quic::{QuicServer, QuicServerSettings, QuicTuning};
use core_reactor::cluster::tls::{self, TlsSettings};
use core_reactor::cluster::transport::{PeerClient, PeerTransport, TransportConfig};
use core_reactor::cluster::{Cluster, ClusterConfig, PullReason};
use core_reactor::evolution::Engine;
use core_reactor::gossip::{Gossip, GossipConfig};
use core_reactor::server::{peer_router, router, AppState};
use core_reactor::store::{id_hex, sha256, Id, Store, StoreConfig};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

const CTOK: &str = "cluster-secret";
const RTOK: &str = "reactor-secret";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Transport {
    Http,
    Quic,
}

struct Node {
    url: String,
    store: Arc<Store>,
    cluster: Arc<Cluster>,
    engine: Arc<Engine>,
    down: Arc<AtomicBool>,
    quic: Option<QuicServer>,
    /// The peer router (with the `down` switch) for extra QUIC listeners.
    peer_app: axum::Router,
    _dir: tempfile::TempDir,
}

#[derive(Clone, Default)]
struct Opts {
    max_bytes: Option<u64>,
    tls: Option<TlsSettings>,
    tls_ca: Option<PathBuf>,
    token: Option<String>,
    min_replicas: Option<usize>,
    /// Encryption at rest: `(key id, master key)`.
    key: Option<(&'static str, [u8; 32])>,
    /// `REACTOR_PACK_THRESHOLD` override (0 = every object is its own file).
    pack_threshold: Option<usize>,
    /// Serve the peer API over QUIC on the UDP port with the same number (needs `tls`).
    quic: bool,
    /// QUIC listener requires client certificates from this CA.
    mtls_ca: Option<PathBuf>,
    /// Client certificate presented to QUIC peers.
    identity: Option<TlsSettings>,
    peer_transport: Option<PeerTransport>,
    connect_timeout: Option<Duration>,
    unsafe_0rtt: bool,
    pull_concurrency: Option<usize>,
}

/// Test PKI: a CA with a leaf for 127.0.0.1 / localhost, and an unrelated second CA + leaf.
struct Pki {
    ca: PathBuf,
    leaf: TlsSettings,
    other_leaf: TlsSettings,
}

fn make_ca_and_leaf(dir: &std::path::Path, name: &str) -> (PathBuf, TlsSettings) {
    use rcgen::{BasicConstraints, CertificateParams, IsCa, KeyPair};
    let ca_key = KeyPair::generate().unwrap();
    let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(rcgen::DnType::CommonName, format!("datran test CA {}", name));
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let leaf_key = KeyPair::generate().unwrap();
    let leaf_params = CertificateParams::new(vec!["127.0.0.1".to_string(), "localhost".to_string()]).unwrap();
    let leaf = leaf_params.signed_by(&leaf_key, &ca, &ca_key).unwrap();
    let ca_path = dir.join(format!("{}-ca.pem", name));
    std::fs::write(&ca_path, ca.pem()).unwrap();
    std::fs::write(dir.join(format!("{}-cert.pem", name)), leaf.pem()).unwrap();
    std::fs::write(dir.join(format!("{}-key.pem", name)), leaf_key.serialize_pem()).unwrap();
    (ca_path, TlsSettings { cert: dir.join(format!("{}-cert.pem", name)), key: dir.join(format!("{}-key.pem", name)) })
}

fn pki() -> &'static Pki {
    static PKI: OnceLock<Pki> = OnceLock::new();
    PKI.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap().keep();
        let (ca, leaf) = make_ca_and_leaf(&dir, "main");
        let (_, other_leaf) = make_ca_and_leaf(&dir, "other");
        Pki { ca, leaf, other_leaf }
    })
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

fn peer_url_of(p: &Pending, quic: bool) -> String {
    if quic {
        p.url.replace("https://", "quic://")
    } else {
        p.url.clone()
    }
}

async fn start(p: Pending, peers: Vec<String>, o: Opts) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let mut ec = test_config(&dir.path().join("evo"), 1);
    ec.persist = false;
    if let Some((id, k)) = o.key {
        ec.keys = Arc::new(core_reactor::crypto::KeyRing::single(id, k));
    }
    let engine = Arc::new(Engine::new(ec));
    let mut sc = StoreConfig::new(dir.path().join("store"));
    sc.max_bytes = o.max_bytes;
    if let Some(t) = o.pack_threshold {
        sc.pack_threshold = t;
    }
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
    cc.tls_identity = o.identity.clone();
    if let Some(t) = o.peer_transport {
        cc.peer_transport = t;
    }
    if let Some(t) = o.connect_timeout {
        cc.connect_timeout = t;
    }
    if let Some(n) = o.pull_concurrency {
        cc.pull_concurrency = n;
    }
    cc.quic.unsafe_0rtt_for_tests = o.unsafe_0rtt;
    let quic_stats = Arc::new(core_reactor::cluster::quic::QuicServerStats::default());
    if o.quic {
        cc.quic_server = Some(quic_stats.clone());
    }
    let cluster = Cluster::start(cc, store.clone()).unwrap();
    let state = AppState {
        engine: engine.clone(),
        gossip: Arc::new(Gossip::new(GossipConfig::disabled())),
        reactor_token: Some(Arc::new(RTOK.as_bytes().to_vec())),
        max_output: 64 << 20,
        store: Some(store.clone()),
        cluster: Some(cluster.clone()),
    };
    let down = Arc::new(AtomicBool::new(false));
    // simulated node failure: every request answers 503 while `down` is set (both listeners)
    let down_layer = |d: Arc<AtomicBool>| {
        axum::middleware::from_fn(move |req: Request, next: Next| {
            let d = d.clone();
            async move {
                if d.load(Ordering::SeqCst) {
                    (axum::http::StatusCode::SERVICE_UNAVAILABLE, "down").into_response()
                } else {
                    next.run(req).await
                }
            }
        })
    };
    let app = router(state.clone()).layer(down_layer(down.clone()));
    let peer_app = peer_router(state).layer(down_layer(down.clone()));
    let addr = p.listener.local_addr().unwrap();
    let quic = if o.quic {
        let tls_files = o.tls.clone().expect("QUIC needs a certificate");
        let mut qs = QuicServerSettings::new(&tls_files);
        qs.client_ca = o.mtls_ca.clone();
        qs.tuning = QuicTuning::default();
        let q = QuicServer::start_with_stats(addr, peer_app.clone(), &qs, quic_stats).unwrap();
        assert_eq!(q.local_addr().port(), addr.port());
        Some(q)
    } else {
        None
    };
    let tls_cfg = o.tls.clone();
    tokio::spawn(async move { tls::serve(p.listener, app, tls_cfg, std::future::pending()).await.unwrap() });
    Node { url: p.url, store, cluster, engine, down, quic, peer_app, _dir: dir }
}

/// Opts for a node of a QUIC cluster (TLS + QUIC listener, trusts the test CA).
fn quic_opts(mut o: Opts) -> Opts {
    let pk = pki();
    o.tls = Some(pk.leaf.clone());
    o.tls_ca = Some(pk.ca.clone());
    o.quic = true;
    o
}

/// `n` nodes, each with every other node as a peer, over `t`.
async fn cluster_t(t: Transport, n: usize, opts: &[Opts]) -> Vec<Node> {
    let quic = t == Transport::Quic;
    let mut pend = Vec::new();
    for _ in 0..n {
        pend.push(bind(quic).await);
    }
    let urls: Vec<String> = pend.iter().map(|p| peer_url_of(p, quic)).collect();
    let mut nodes = Vec::new();
    for (i, p) in pend.into_iter().enumerate() {
        let peers = urls.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, u)| u.clone()).collect();
        let o = opts.get(i).cloned().unwrap_or_default();
        nodes.push(start(p, peers, if quic { quic_opts(o) } else { o }).await);
    }
    nodes
}

/// QUIC mode: all peer traffic went over QUIC (no fallback, no HTTPS request at all).
fn assert_transport(t: Transport, nodes: &[&Node]) {
    let total_quic: u64 = nodes.iter().map(|n| n.cluster.transport.stats().requests("quic")).sum();
    for n in nodes {
        let s = n.cluster.transport.stats();
        match t {
            Transport::Quic => {
                assert_eq!(s.requests("https") + s.requests("http"), 0, "no HTTP(S) peer request in QUIC mode: {}", n.cluster.transport.stats_json());
                assert_eq!(s.fallbacks.load(Ordering::Relaxed), 0);
            }
            Transport::Http => assert_eq!(s.requests("quic"), 0),
        }
    }
    if t == Transport::Quic {
        assert!(total_quic > 0, "peer requests went over QUIC");
        let served: u64 = nodes.iter().filter_map(|n| n.quic.as_ref()).map(|q| q.stats.requests.load(Ordering::Relaxed)).sum();
        assert!(served > 0, "requests served by the QUIC listeners");
    }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .tls_certs_only(reqwest::Certificate::from_pem_bundle(&std::fs::read(&pki().ca).unwrap()).unwrap())
        .build()
        .unwrap()
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

/// Runs a scenario over HTTP and over QUIC.
macro_rules! both_transports {
    ($name:ident) => {
        mod $name {
            use super::*;
            #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
            async fn http() {
                super::$name(Transport::Http).await
            }
            #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
            async fn quic() {
                super::$name(Transport::Quic).await
            }
        }
    };
}

both_transports!(remote_read_gravity_pull_and_leased_drop);
async fn remote_read_gravity_pull_and_leased_drop(t: Transport) {
    let nodes = cluster_t(t, 3, &[]).await;
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
    // the pull commits before its counter is bumped: wait for both
    wait_for("gravity pull on C", || holds(c, &fid) && metric(c, "pulls") == 1).await;
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
    assert_transport(t, &[a, b, c]);
}

both_transports!(repair_after_node_loss_without_stampede);
async fn repair_after_node_loss_without_stampede(t: Transport) {
    let nodes = cluster_t(t, 4, &[]).await;
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
    assert_transport(t, &all);
}

both_transports!(tombstones_propagate_and_old_replicas_do_not_resurrect);
async fn tombstones_propagate_and_old_replicas_do_not_resurrect(t: Transport) {
    let nodes = cluster_t(t, 3, &[]).await;
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
    assert_transport(t, &[a, b, c]);
}

both_transports!(corrupt_object_is_quarantined_and_repaired_from_peer);
async fn corrupt_object_is_quarantined_and_repaired_from_peer(t: Transport) {
    let nodes = cluster_t(t, 2, &[]).await;
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
    assert_transport(t, &[a, b]);
}

both_transports!(encrypted_nodes_with_different_keys_replicate_and_repair);
/// Encryption at rest across nodes with DIFFERENT master keys: objects travel in transport form
/// (blob v2, decrypted but compressed) and are re-sealed under the receiver's key; a tampered
/// encrypted object fails its AEAD tag in scrub, is quarantined and repaired from the peer.
async fn encrypted_nodes_with_different_keys_replicate_and_repair(t: Transport) {
    let ka = Opts { key: Some(("node-a-key", [0xa1; 32])), pack_threshold: Some(0), ..Default::default() };
    let kb = Opts { key: Some(("node-b-key", [0xb2; 32])), pack_threshold: Some(0), ..Default::default() };
    let nodes = cluster_t(t, 2, &[ka, kb]).await;
    let (a, b) = (&nodes[0], &nodes[1]);
    let data = text(700_000, 21);
    let fid = put_ok(a, &data).await;

    // remote read on B (objects fetched from A, verified, served)
    let (st, body, h) = get(b, &fid, Some("bytes=1000-200999")).await;
    assert_eq!((st, h["x-reactor-remote"].to_str().unwrap()), (206, "1"));
    assert_eq!(body, &data[1000..201000]);

    // the wire form is a plain blob v2, never A's envelope
    let oid = a.store.chunk_refs(&fid).unwrap().unwrap().1[0].object_id;
    let wire = a.store.get_object_raw(&oid).unwrap().unwrap();
    assert_eq!(wire[0], 0x10, "transport form is blob v2");
    let on_disk = std::fs::read(a.store.object_storage(&oid).unwrap().unwrap().path).unwrap();
    assert_eq!(core_reactor::crypto::sealed_key_id(&on_disk), Some("node-a-key"));

    // replica pull: B stores everything under ITS key
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    assert_eq!(b.store.read_to_vec(&fid, None).unwrap(), data);
    let enc = &b.store.stats().unwrap()["encryption"];
    let n_objects = b.store.stats().unwrap()["objects"].as_u64().unwrap();
    assert_eq!(enc["objects_by_key"]["node-b-key"].as_u64(), Some(n_objects), "{}", enc);
    assert_eq!(enc["plaintext_objects"], 0);
    let bpath = b.store.object_storage(&oid).unwrap().unwrap().path;
    assert_eq!(core_reactor::crypto::sealed_key_id(&std::fs::read(&bpath).unwrap()), Some("node-b-key"));
    assert!(b.store.verify_index(true).unwrap().ok());
    gossip_all(&[a, b]).await;

    // tamper with B's encrypted object (file objects have no CRC: the AEAD tag catches it)
    let mut raw = std::fs::read(&bpath).unwrap();
    let mid = raw.len() / 2;
    raw[mid] ^= 0x01;
    std::fs::write(&bpath, &raw).unwrap();
    let s = b.store.clone();
    let rep = tokio::task::spawn_blocking(move || s.scrub_step(u64::MAX)).await.unwrap().unwrap();
    assert_eq!(rep.corrupt, vec![id_hex(&oid)], "AEAD failure quarantines");
    wait_for("quarantine repair from A", || metric(b, "quarantine_repairs") == 1).await;
    assert!(b.store.quarantined().unwrap().is_empty());
    assert_eq!(core_reactor::crypto::sealed_key_id(&std::fs::read(&bpath).unwrap()), Some("node-b-key"), "repaired copy is re-sealed under B's key");
    assert_eq!(b.store.read_to_vec(&fid, None).unwrap(), data);
    assert!(b.store.verify_index(true).unwrap().ok());
    assert_transport(t, &[a, b]);
}

both_transports!(cluster_auth_and_wire_shapes);
async fn cluster_auth_and_wire_shapes(t: Transport) {
    let quic = t == Transport::Quic;
    let mut pend = vec![bind(quic).await, bind(quic).await];
    let (pb, pa) = (pend.pop().unwrap(), pend.pop().unwrap());
    let ua = pa.url.clone();
    let (pua, pub_) = (peer_url_of(&pa, quic), peer_url_of(&pb, quic));
    let oa = if quic { quic_opts(Opts::default()) } else { Opts::default() };
    let ob = Opts { token: Some("wrong-token".into()), ..Default::default() };
    let a = start(pa, vec![pub_], oa).await;
    let b = start(pb, vec![pua], if quic { quic_opts(ob) } else { ob }).await;
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
    if quic {
        // the 401 came over QUIC (token check is defence in depth on top of TLS)
        assert_eq!(st["peers"][0]["transport"]["transport"], "quic", "{}", st["peers"][0]);
        assert!(b.cluster.transport.stats().requests("quic") >= 1);
        assert!(a.quic.as_ref().unwrap().stats.requests.load(Ordering::Relaxed) >= 1);
    }

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
    // the read hook fires when the streaming task finishes, which may be just after the client
    // received the last byte
    for _ in 0..100 {
        if a.cluster.demand(&fid) > 0.0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
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
    for k in ["node_id", "region", "tls", "cluster_size", "min_replicas", "min_replicas_effective", "peers", "holders_sample", "demand_top", "metrics", "transport"] {
        assert!(st.get(k).is_some(), "status.{}", k);
    }
    assert_eq!(st["holders_sample"][0]["holders"], serde_json::json!([a.cluster.cfg.node_id]));
    for k in ["pulls", "drops", "repairs", "remote_read_bytes", "leases_active"] {
        assert!(st["metrics"][k].is_number(), "status.metrics.{}", k);
    }
    assert!(st["peers"][0]["transport"]["transport"].is_string());
    if quic {
        assert!(st["quic_server"]["requests"].is_number(), "{}", st["quic_server"]);
    }
    let stats: Value = c.get(format!("{}/store/stats", ua)).header("x-reactor-token", RTOK).send().await.unwrap().json().await.unwrap();
    assert!(stats["cluster"]["pulls"].is_number(), "/store/stats carries the gravity metrics");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tls_between_peers() {
    let certs = tempfile::tempdir().unwrap();
    let (ca, tls_files) = make_ca_and_leaf(certs.path(), "tls");
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
    let (st, body, _) = {
        let r = reqwest::Client::new().get(format!("{}/store/files/{}", b.url, id_hex(&fid))).header("x-reactor-token", RTOK).send().await.unwrap();
        let st = r.status().as_u16();
        let h = r.headers().clone();
        (st, r.bytes().await.unwrap().to_vec(), h)
    };
    assert!(st == 200 && body == data, "remote read over TLS");
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    assert_eq!(b.store.read_to_vec(&fid, None).unwrap(), data);
    assert_eq!(b.cluster.status()["peers"][0]["transport"]["transport"], "https");

    // without the CA the peer's certificate is not trusted
    c.cluster.gossip_round().await;
    assert_eq!(c.cluster.status()["peers"][0]["healthy"], false);
    assert!(a.cluster.status()["tls"].as_bool().unwrap());
    // plain HTTP to the TLS port fails
    let plain = reqwest::Client::new().get(format!("{}/health", ua.replace("https://", "http://"))).send().await;
    assert!(!plain.map(|r| r.status().is_success()).unwrap_or(false));
}

both_transports!(eviction_never_drops_below_min_replicas);
async fn eviction_never_drops_below_min_replicas(t: Transport) {
    let opts = [Opts::default(), Opts { max_bytes: Some(1_600_000), ..Default::default() }, Opts::default()];
    let nodes = cluster_t(t, 3, &opts).await;
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
    assert_transport(t, &[a, b, c]);
}

// ---------------------------------------------------------------------------------------------
// QUIC specifics
// ---------------------------------------------------------------------------------------------

/// Mutual TLS: the QUIC listener refuses clients without a certificate or with one from another
/// CA (handshake failure, counted on both sides); a client with a certificate from the cluster
/// CA gets through.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quic_mtls_rejects_wrong_ca_and_missing_client_cert() {
    let pk = pki();
    let pa = bind(true).await;
    let ua = peer_url_of(&pa, true);
    let a = start(pa, vec![], quic_opts(Opts { mtls_ca: Some(pk.ca.clone()), ..Default::default() })).await;
    let fid = put_ok(&a, &text(100_000, 5)).await;
    let strict = |identity: Option<TlsSettings>| Opts {
        identity,
        peer_transport: Some(PeerTransport::QuicOnly),
        connect_timeout: Some(Duration::from_secs(3)),
        ..quic_opts(Opts::default())
    };
    let wrong_ca = start(bind(true).await, vec![ua.clone()], strict(Some(pk.other_leaf.clone()))).await;
    let no_cert = start(bind(true).await, vec![ua.clone()], strict(None)).await;
    let good = start(bind(true).await, vec![ua.clone()], strict(Some(pk.leaf.clone()))).await;

    let server = &a.quic.as_ref().unwrap().stats;
    for n in [&wrong_ca, &no_cert] {
        let before = server.handshake_failures.load(Ordering::Relaxed);
        n.cluster.gossip_round().await;
        let st = n.cluster.status();
        assert_eq!(st["peers"][0]["healthy"], false, "{}", st["peers"][0]);
        assert!(n.cluster.transport.stats().requests("https") == 0, "quic-only never falls back");
        assert!(st["transport"]["quic_client"]["handshake_failures"].as_u64().unwrap() >= 1, "{}", st["transport"]);
        wait_for("server-side handshake failure", || server.handshake_failures.load(Ordering::Relaxed) > before).await;
        assert!(n.cluster.pull(&fid, PullReason::Manual).await.is_err());
    }
    assert_eq!(server.requests.load(Ordering::Relaxed), 0, "no request from a refused client reached the router");

    good.cluster.gossip_round().await;
    let st = good.cluster.status();
    assert_eq!(st["peers"][0]["healthy"], true, "{}", st["peers"][0]);
    assert_eq!(st["peers"][0]["transport"]["transport"], "quic");
    assert!(good.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    assert!(server.requests.load(Ordering::Relaxed) >= 2);
}

/// Token check over QUIC (defence in depth): a TLS-authenticated client with the wrong
/// `x-cluster-token` is answered 401 by the same middleware as over HTTP.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quic_token_reject() {
    let pk = pki();
    let pa = bind(true).await;
    let ua = peer_url_of(&pa, true);
    let a = start(pa, vec![], quic_opts(Opts::default())).await;
    let cfg = TransportConfig { prefer: PeerTransport::QuicOnly, tls_ca: Some(pk.ca.clone()), ..TransportConfig::default() };
    let pc = PeerClient::new(cfg).unwrap();
    for (tok, expect) in [("", "HTTP 401"), ("wrong", "HTTP 401"), (RTOK, "HTTP 401")] {
        let e = pc.get(&format!("{}/cluster/inventory", ua), tok, 1 << 20).await.unwrap_err();
        assert_eq!(e, expect);
    }
    let e = pc.post(&format!("{}/cluster/unpin/{}", ua, "00".repeat(32)), "nope", 1 << 16).await.unwrap_err();
    assert_eq!(e, "HTTP 401");
    let inv: Value = serde_json::from_slice(&pc.get(&format!("{}/cluster/inventory", ua), CTOK, 1 << 20).await.unwrap()).unwrap();
    assert_eq!(inv["node_id"], a.cluster.cfg.node_id.as_str());
    // non-peer endpoints are not served on the QUIC listener at all
    let e = pc.get(&format!("{}/store/stats", ua), CTOK, 1 << 20).await.unwrap_err();
    assert_eq!(e, "HTTP 404");
    assert_eq!(pc.stats().requests("https"), 0);
    // response size caps are enforced like on the HTTP path
    let e = pc.get(&format!("{}/cluster/inventory", ua), CTOK, 16).await.unwrap_err();
    assert!(e.contains("larger than 16 bytes"), "{}", e);
}

/// `quic://` peer whose UDP port is closed: the handshake times out, the request falls back to
/// HTTPS on the same port number, and status / metrics record it. `quic-only` does not fall back.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quic_falls_back_to_https_when_udp_port_closed() {
    let pk = pki();
    let pa = bind(true).await;
    let ua = peer_url_of(&pa, true);
    // A serves HTTPS only (no QUIC listener)
    let a = start(pa, vec![], Opts { tls: Some(pk.leaf.clone()), tls_ca: Some(pk.ca.clone()), ..Default::default() }).await;
    let data = text(300_000, 8);
    let fid = put_ok(&a, &data).await;
    let b = start(bind(false).await, vec![ua.clone()], Opts { tls_ca: Some(pk.ca.clone()), connect_timeout: Some(Duration::from_millis(1500)), ..Default::default() }).await;

    b.cluster.gossip_round().await;
    let st = b.cluster.status();
    let p = &st["peers"][0];
    assert_eq!(p["healthy"], true, "{}", p);
    assert_eq!(p["transport"]["transport"], "https", "{}", p);
    assert_eq!(p["transport"]["configured_transport"], "quic");
    assert_eq!(p["transport"]["quic_fallbacks"], 1);
    assert!(p["transport"]["quic_error"].as_str().unwrap().contains("QUIC"), "{}", p);
    assert_eq!(st["transport"]["fallbacks"], 1);
    assert!(st["transport"]["quic_client"]["handshake_failures"].as_u64().unwrap() >= 1);
    // later requests go straight to HTTPS while the fallback is fresh (no second handshake wait)
    let t = std::time::Instant::now();
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    assert!(t.elapsed() < Duration::from_millis(1400), "no new QUIC attempt during the back-off");
    assert!(b.cluster.transport.stats().requests("https") >= 3);
    assert_eq!(b.store.read_to_vec(&fid, None).unwrap(), data);
    let st = b.cluster.status();
    assert_eq!(st["transport"]["fallbacks"], 1);
    let m = core_reactor::metrics::render(&b.engine, None, Some(&b.cluster));
    assert!(m.contains("reactor_cluster_peer_fallbacks_total"), "fallback metric exported");
    assert!(m.contains("reactor_quic_handshake_failures_total{side=\"client\"}"));
    assert!(m.contains("reactor_cluster_peer_requests_total{method=\"GET\",result=\"ok\",transport=\"https\"}"));

    // quic-only: no fallback, the peer is unhealthy
    let c = start(
        bind(false).await,
        vec![ua.clone()],
        Opts { tls_ca: Some(pk.ca.clone()), connect_timeout: Some(Duration::from_millis(800)), peer_transport: Some(PeerTransport::QuicOnly), ..Default::default() },
    )
    .await;
    c.cluster.gossip_round().await;
    assert_eq!(c.cluster.status()["peers"][0]["healthy"], false);
    assert_eq!(c.cluster.transport.stats().requests("https"), 0);
}

/// 0-RTT: after a reconnect with a session ticket, GETs go out in 0-RTT and the server sees them
/// before the handshake completes; POSTs (hold leases) never do — asserted on the server, which
/// classifies streams exactly at accept time. With the client-side guard disabled (test hook) the
/// server does see early POSTs and holds them until the handshake completes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quic_zero_rtt_only_for_idempotent_requests() {
    let pa = bind(true).await;
    let ua = peer_url_of(&pa, true);
    let a = start(pa, vec![], quic_opts(Opts::default())).await;
    let fid = put_ok(&a, &text(200_000, 6)).await;
    let server = a.quic.as_ref().unwrap().stats.clone();
    let hold_url = format!("{}/cluster/hold/{}?node=t", ua, id_hex(&fid));

    for unsafe_hook in [false, true] {
        let b = start(bind(true).await, vec![ua.clone()], quic_opts(Opts { unsafe_0rtt: unsafe_hook, ..Default::default() })).await;
        b.cluster.gossip_round().await; // full handshake; the server issues tickets
        assert_eq!(b.cluster.status()["peers"][0]["transport"]["transport"], "quic");
        let early_unsafe_before = server.early_unsafe.load(Ordering::Relaxed);
        let early_safe_before = server.early_safe.load(Ordering::Relaxed);
        for _ in 0..30 {
            b.cluster.transport.reset_quic();
            // first requests on the fresh connection: a GET and a POST, back to back
            let (g, h) = tokio::join!(b.cluster.gossip_round(), b.cluster.transport.post(&hold_url, CTOK, 1 << 16));
            let () = g;
            let h: Value = serde_json::from_slice(&h.unwrap_or_else(|e| panic!("hold over QUIC: {}", e))).unwrap();
            assert_eq!(h["granted"], true, "{}", h);
            let done = server.early_safe.load(Ordering::Relaxed) > early_safe_before
                && (!unsafe_hook || server.early_unsafe.load(Ordering::Relaxed) > early_unsafe_before);
            if done {
                break;
            }
        }
        let qc = b.cluster.transport.quic_stats().unwrap();
        assert!(qc["zero_rtt_accepted"].as_u64().unwrap() >= 1, "0-RTT resumption used: {}", qc);
        assert!(server.early_safe.load(Ordering::Relaxed) > early_safe_before, "GETs arrived in 0-RTT: {}", server.json());
        if !unsafe_hook {
            assert_eq!(server.early_unsafe.load(Ordering::Relaxed), early_unsafe_before, "no POST ever arrived in 0-RTT: {}", server.json());
            assert_eq!(qc["early_sent_unsafe"], 0);
            assert!(qc["early_sent_safe"].as_u64().unwrap() >= 1);
        } else {
            let early_unsafe = server.early_unsafe.load(Ordering::Relaxed);
            assert!(early_unsafe > early_unsafe_before, "server detects early POSTs: {}", server.json());
            assert_eq!(server.early_unsafe_deferred.load(Ordering::Relaxed), early_unsafe, "every early POST was held until the handshake completed");
            assert_eq!(server.early_unsafe_refused.load(Ordering::Relaxed), 0);
        }
    }
}

/// Object pulls run concurrently on one QUIC connection (one stream per object).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quic_pull_uses_one_connection_with_parallel_streams() {
    let nodes = cluster_t(Transport::Quic, 2, &[Opts::default(), Opts { pull_concurrency: Some(16), pack_threshold: Some(0), ..Default::default() }]).await;
    let (a, b) = (&nodes[0], &nodes[1]);
    let data = random_bytes(6_000_000, 31);
    let fid = put_ok(a, &data).await;
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    assert_eq!(b.store.read_to_vec(&fid, None).unwrap(), data);
    let qc = b.cluster.transport.quic_stats().unwrap();
    assert_eq!(qc["connections"], 1, "one connection per peer: {}", qc);
    let served = a.quic.as_ref().unwrap().stats.json();
    assert_eq!(served["connections"], 1);
    assert!(served["requests"].as_u64().unwrap() as usize >= a.store.chunk_refs(&fid).unwrap().unwrap().1.len());
    assert_transport(Transport::Quic, &[a, b]);
}

// ---------------------------------------------------------------------------------------------
// Lossy UDP proxy + benchmark
// ---------------------------------------------------------------------------------------------

/// In-process UDP proxy in front of `upstream` dropping each datagram with probability `loss`
/// (both directions, deterministic RNG). Returns the address clients should use.
async fn lossy_proxy(upstream: std::net::SocketAddr, loss: f64, seed: u64) -> (std::net::SocketAddr, Arc<std::sync::atomic::AtomicU64>) {
    let front = Arc::new(tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap());
    let back = Arc::new(tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap());
    back.connect(upstream).await.unwrap();
    let addr = front.local_addr().unwrap();
    let client = Arc::new(std::sync::Mutex::new(None::<std::net::SocketAddr>));
    let dropped = Arc::new(std::sync::atomic::AtomicU64::new(0));
    // `Lcg::next` yields 31 bits
    let threshold = (loss * (1u64 << 31) as f64) as u64;
    {
        let (front, back, client, dropped) = (front.clone(), back.clone(), client.clone(), dropped.clone());
        tokio::spawn(async move {
            let mut rng = Lcg(seed);
            let mut buf = vec![0u8; 65536];
            while let Ok((n, from)) = front.recv_from(&mut buf).await {
                *client.lock().unwrap() = Some(from);
                if rng.next() < threshold {
                    dropped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                let _ = back.send(&buf[..n]).await;
            }
        });
    }
    {
        let dropped = dropped.clone();
        tokio::spawn(async move {
            let mut rng = Lcg(seed ^ 0x5eed);
            let mut buf = vec![0u8; 65536];
            loop {
                let n = match back.recv(&mut buf).await {
                    Ok(n) => n,
                    Err(_) => continue, // ICMP errors surface as recv errors on some platforms
                };
                if rng.next() < threshold {
                    dropped.fetch_add(1, Ordering::Relaxed);
                    continue;
                }
                let to = *client.lock().unwrap();
                if let Some(to) = to {
                    let _ = front.send_to(&buf[..n], to).await;
                }
            }
        });
    }
    (addr, dropped)
}

/// Correctness under loss: a replica pull over QUIC through a proxy dropping 2 % of datagrams.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn quic_pull_survives_packet_loss() {
    let pa = bind(true).await;
    let a = start(pa, vec![], quic_opts(Opts::default())).await;
    let data = random_bytes(3_000_000, 41);
    let fid = put_ok(&a, &data).await;
    let (proxy, dropped) = lossy_proxy(a.quic.as_ref().unwrap().local_addr(), 0.02, 7).await;
    let b = start(bind(true).await, vec![format!("quic://{}", proxy)], quic_opts(Opts { peer_transport: Some(PeerTransport::QuicOnly), ..Default::default() })).await;
    b.cluster.gossip_round().await;
    assert!(b.cluster.pull(&fid, PullReason::Manual).await.unwrap());
    assert_eq!(b.store.read_to_vec(&fid, None).unwrap(), data);
    assert!(dropped.load(Ordering::Relaxed) > 0, "the proxy dropped datagrams");
}

/// Benchmark (run explicitly, release build recommended):
/// `cargo test --release --test cluster quic_bench -- --ignored --nocapture`
///
/// Pull of a replica with many objects from one origin over HTTPS (HTTP/1.1, reqwest pool) and
/// over QUIC (one connection, parallel streams); then QUIC through the lossy proxy at 0 / 1 /
/// 2 % loss with 1 vs 8 concurrent object fetches. `DATRAN_BENCH_MIB` (default 500) sets the
/// size. Every puller is a fresh node (no dedup between runs).
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore]
async fn quic_bench() {
    let mib: usize = std::env::var("DATRAN_BENCH_MIB").ok().and_then(|v| v.parse().ok()).unwrap_or(500);
    let pk = pki();
    let pa = bind(true).await;
    let https_url = pa.url.clone();
    let quic_url = peer_url_of(&pa, true);
    let a = start(pa, vec![], quic_opts(Opts::default())).await;
    // mixed, partly compressible content: text and random runs
    let mut data = Vec::with_capacity(mib << 20);
    let mut seed = 1u64;
    while data.len() < mib << 20 {
        data.extend_from_slice(&text(1 << 20, seed));
        data.extend_from_slice(&random_bytes(1 << 20, seed + 1));
        seed += 2;
    }
    data.truncate(mib << 20);
    let t = std::time::Instant::now();
    let s = a.store.clone();
    let d = data.clone();
    let out = tokio::task::spawn_blocking(move || s.put_bytes(&d, &core_reactor::store::PutOptions { content_type: None, sample: false })).await.unwrap().unwrap();
    let fid = out.file_id;
    let objects = a.store.chunk_refs(&fid).unwrap().unwrap().1.iter().map(|r| r.object_id).collect::<std::collections::HashSet<_>>().len();
    let stored = a.store.stats().unwrap()["live_physical_bytes"].as_u64().unwrap();
    println!(
        "origin: {} MiB file, {} objects, {:.1} MiB stored (transfer volume), ingest {:.1}s",
        mib,
        objects,
        stored as f64 / 1048576.0,
        t.elapsed().as_secs_f64()
    );

    async fn pull_once(label: &str, peer: String, o: Opts, fid: Id, stored: u64) -> f64 {
        let n = start(bind(true).await, vec![peer], o).await;
        n.cluster.gossip_round().await;
        let t = std::time::Instant::now();
        let r = n.cluster.pull(&fid, PullReason::Manual).await;
        let secs = t.elapsed().as_secs_f64();
        assert!(r.as_ref().is_ok_and(|v| *v), "{}: {:?}", label, r);
        let tr = n.cluster.transport.stats_json();
        println!(
            "{:<40} {:>7.2} s  {:>7.1} MiB/s  (quic req {}, https req {})",
            label,
            secs,
            stored as f64 / 1048576.0 / secs,
            tr["quic"]["requests"],
            tr["https"]["requests"]
        );
        secs
    }
    let base = |conc: usize| Opts { tls_ca: Some(pk.ca.clone()), pull_concurrency: Some(conc), ..Default::default() };
    for conc in [1usize, 8] {
        pull_once(&format!("HTTPS (HTTP/1.1), concurrency {}", conc), https_url.clone(), base(conc), fid, stored).await;
        pull_once(&format!("QUIC (HTTP/3), concurrency {}", conc), quic_url.clone(), Opts { peer_transport: Some(PeerTransport::QuicOnly), ..base(conc) }, fid, stored).await;
    }
    // the sender (origin) runs the congestion controller: a second listener on A with BBR
    let mut qs = QuicServerSettings::new(&pk.leaf);
    qs.tuning.congestion = core_reactor::cluster::quic::Congestion::Bbr;
    let bbr = QuicServer::start("127.0.0.1:0".parse().unwrap(), a.peer_app.clone(), &qs).unwrap();
    for conc in [1usize, 8] {
        pull_once(&format!("QUIC (HTTP/3) BBR, concurrency {}", conc), format!("quic://{}", bbr.local_addr()), Opts { peer_transport: Some(PeerTransport::QuicOnly), ..base(conc) }, fid, stored).await;
    }
    for loss in [0.0, 0.01, 0.02] {
        for conc in [1usize, 8] {
            let (proxy, dropped) = lossy_proxy(a.quic.as_ref().unwrap().local_addr(), loss, 99).await;
            let label = format!("QUIC via proxy, loss {:.0}%, concurrency {}", loss * 100.0, conc);
            pull_once(&label, format!("quic://{}", proxy), Opts { peer_transport: Some(PeerTransport::QuicOnly), ..base(conc) }, fid, stored).await;
            println!("{:<40} dropped {} datagrams", "", dropped.load(Ordering::Relaxed));
        }
    }
}
