//! Data gravity: demand-driven replication between reactors (NETWORK_SPEC §4).
//!
//! Each node has a stable random `node_id` (persisted in `$REACTOR_STATE_DIR/node_id`) and an
//! optional `REACTOR_REGION`. Every `REACTOR_GOSSIP_INTERVAL_MS` a node runs one *maintenance
//! round*:
//!
//! 1. **Inventory gossip** — `GET /cluster/inventory?since=<version>&tsince=<ms>` from every
//!    peer: versioned add/remove deltas from the store's file log (full listing when `since` is
//!    unknown, plus a periodic full resync), tombstones, demand summary and capacity. This
//!    builds `holders: file_id → {node_id}` and per-peer demand. Tombstones are applied locally.
//! 2. **Repair** — files with fewer than `min(REACTOR_MIN_REPLICAS, healthy cluster size)`
//!    healthy holders are pulled by exactly one node: the healthy non-holder with the most free
//!    capacity (tie-break: smallest node_id). Every node evaluates the same deterministic rule,
//!    so concurrent repairs do not stampede.
//! 3. **Gravity drop** — a local replica with near-zero local demand that is in demand
//!    elsewhere is dropped only after `min(REACTOR_MIN_REPLICAS, cluster size)` *other* healthy
//!    holders granted a hold-lease (`POST /cluster/hold/:id`, 10 min). A pinned origin file is
//!    dropped only after one of those holders accepted origin transfer (it takes over the pins).
//!
//! Reads of files that are not held locally are served remotely (`remote`): manifest from a
//! holder, then only the objects overlapping the requested range, every object and chunk hash
//! verified, objects cached in a bounded LRU. Local and remote reads record demand
//! (exponentially decayed, half-life `REACTOR_DEMAND_HALFLIFE_MS`); when the demand for a file
//! that is not held reaches `REACTOR_GRAVITY_PULL`, the node pulls a full replica through the
//! store's import path (dedup applies).
//!
//! The store's eviction policy is replaced by [`policy::GravityPolicy`] (cold replicas are
//! evicted only when enough other holders granted leases) and its quarantine hook re-fetches
//! corrupt objects from peers (`repair_object_raw`, falling back to per-chunk plaintext).

pub mod http;
mod policy;
pub mod quic;
pub mod remote;
pub mod tls;
pub mod transport;

use crate::state::now_ms;
use crate::store::{self, id_hex, parse_id, FileMeta, Id, Manifest, Store, StoreError};
use ::http::Method;
use transport::{PeerClient, PeerTransport, TransportConfig};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

/// Cap on a `/cluster/inventory` response.
pub const MAX_INVENTORY_BYTES: usize = 64 << 20;
/// Cap on a `/cluster/manifests/:id` response.
pub const MAX_MANIFEST_BYTES: usize = 64 << 20;
/// Cap on a `/cluster/objects/:id` response (raw blob-v2 object).
pub const MAX_OBJECT_BYTES: usize = store::OBJECT_MAX_PLAIN + (64 << 10);
/// Cap on small JSON responses (hold, unpin).
pub const MAX_SMALL_BYTES: usize = 64 << 10;
/// Inventory delta page size.
const INVENTORY_PAGE: usize = 10_000;
/// Files listed in a full inventory (beyond this a node advertises only the first ids).
const INVENTORY_FULL_MAX: usize = 1_000_000;
/// Demand entries advertised per inventory.
const DEMAND_ADVERTISED: usize = 1_000;
/// Pulls started per repair pass.
const REPAIRS_PER_PASS: usize = 32;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn env_parse<T: std::str::FromStr>(name: &str) -> Option<T> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct ClusterConfig {
    /// Stable random id (32 hex chars), persisted in `<state_dir>/node_id`.
    pub node_id: String,
    /// `REACTOR_REGION`.
    pub region: Option<String>,
    /// `REACTOR_PEERS` (base URLs).
    pub peers: Vec<String>,
    /// `REACTOR_CLUSTER_TOKEN`; without it the cluster is disabled.
    pub cluster_token: Option<String>,
    /// `REACTOR_GOSSIP_INTERVAL_MS` (default 60 s): inventory gossip + maintenance round.
    pub interval: Duration,
    /// `REACTOR_DEMAND_HALFLIFE_MS` (default 1 h).
    pub demand_half_life: Duration,
    /// `REACTOR_GRAVITY_PULL` (default 3): local demand at which a non-held file is pulled.
    pub gravity_pull: f64,
    /// `REACTOR_GRAVITY_DROP_BELOW` (default 0.5): local demand under which a replica is cold.
    pub drop_below: f64,
    /// Peer demand at which a cold replica counts as "in demand elsewhere" (default 1).
    pub drop_peer_demand: f64,
    /// `REACTOR_MIN_REPLICAS` (default 2), capped at the cluster size.
    pub min_replicas: usize,
    /// Hold-lease duration (10 min).
    pub lease_ttl: Duration,
    /// A peer is unhealthy when its last inventory fetch failed or is older than this
    /// (default 3 × interval).
    pub peer_timeout: Duration,
    /// Per-request timeout of every cluster fetch (default 30 s) and connect timeout (5 s).
    pub request_timeout: Duration,
    pub connect_timeout: Duration,
    /// `REACTOR_REMOTE_CACHE_BYTES` (default 256 MiB): decoded objects of remote reads.
    pub cache_bytes: u64,
    /// Every N-th inventory fetch per peer is a full resync (default 30).
    pub full_sync_every: u64,
    /// `REACTOR_TLS_CA`: PEM bundle trusted for `https://` peers (replaces the built-in roots).
    pub tls_ca: Option<PathBuf>,
    /// Where `node_id` and the granted leases are persisted.
    pub state_dir: PathBuf,
    /// This node serves HTTPS (`REACTOR_TLS_CERT`/`REACTOR_TLS_KEY`); informational.
    pub tls_server: bool,
    /// `REACTOR_PEER_TRANSPORT` (http, quic, quic-only).
    pub peer_transport: PeerTransport,
    /// QUIC tuning (`REACTOR_QUIC_*`), shared with the QUIC listener.
    pub quic: quic::QuicTuning,
    /// Client certificate for QUIC mutual TLS (`REACTOR_TLS_CERT` / `REACTOR_TLS_KEY`).
    pub tls_identity: Option<tls::TlsSettings>,
    /// After a failed QUIC handshake a peer is served over HTTP(S) for this long (60 s).
    pub fallback_retry: Duration,
    /// Objects fetched concurrently by a replica pull (`REACTOR_PULL_CONCURRENCY`, default 8).
    pub pull_concurrency: usize,
    /// Counters of this node's QUIC listener (reported in `/cluster/status`).
    pub quic_server: Option<Arc<quic::QuicServerStats>>,
}

/// Loads `<state_dir>/node_id` or creates it (16 random bytes, hex).
pub fn load_or_create_node_id(state_dir: &Path) -> std::io::Result<String> {
    let path = state_dir.join("node_id");
    if let Ok(s) = std::fs::read_to_string(&path) {
        let s = s.trim().to_string();
        if s.len() >= 8 && s.len() <= 64 && s.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Ok(s.to_ascii_lowercase());
        }
    }
    std::fs::create_dir_all(state_dir)?;
    let id: [u8; 16] = rand::random();
    let s = hex::encode(id);
    write_atomic(&path, s.as_bytes())?;
    Ok(s)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension(format!("tmp{}", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

impl ClusterConfig {
    /// Defaults with a persisted node id under `state_dir`.
    pub fn new(state_dir: &Path) -> std::io::Result<ClusterConfig> {
        let interval = Duration::from_secs(60);
        Ok(ClusterConfig {
            node_id: load_or_create_node_id(state_dir)?,
            region: None,
            peers: Vec::new(),
            cluster_token: None,
            interval,
            demand_half_life: Duration::from_secs(3600),
            gravity_pull: 3.0,
            drop_below: 0.5,
            drop_peer_demand: 1.0,
            min_replicas: 2,
            lease_ttl: Duration::from_secs(600),
            peer_timeout: interval * 3,
            request_timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(5),
            cache_bytes: 256 << 20,
            full_sync_every: 30,
            tls_ca: None,
            state_dir: state_dir.to_path_buf(),
            tls_server: false,
            peer_transport: PeerTransport::Http,
            quic: quic::QuicTuning::default(),
            tls_identity: None,
            fallback_retry: Duration::from_secs(60),
            pull_concurrency: 8,
            quic_server: None,
        })
    }

    pub fn from_env(state_dir: &Path) -> std::io::Result<ClusterConfig> {
        let mut c = ClusterConfig::new(state_dir)?;
        c.region = std::env::var("REACTOR_REGION").ok().map(|s| s.trim().chars().take(64).collect::<String>()).filter(|s| !s.is_empty());
        c.peers = crate::gossip::parse_peers(&std::env::var("REACTOR_PEERS").unwrap_or_default());
        c.cluster_token = std::env::var("REACTOR_CLUSTER_TOKEN").ok().filter(|t| !t.is_empty());
        if let Some(ms) = env_parse::<u64>("REACTOR_GOSSIP_INTERVAL_MS") {
            c.interval = Duration::from_millis(ms.max(100));
            c.peer_timeout = c.interval * 3;
        }
        if let Some(ms) = env_parse::<u64>("REACTOR_DEMAND_HALFLIFE_MS").filter(|v| *v > 0) {
            c.demand_half_life = Duration::from_millis(ms);
        }
        if let Some(v) = env_parse::<f64>("REACTOR_GRAVITY_PULL").filter(|v| v.is_finite() && *v > 0.0) {
            c.gravity_pull = v;
        }
        if let Some(v) = env_parse::<f64>("REACTOR_GRAVITY_DROP_BELOW").filter(|v| v.is_finite() && *v >= 0.0) {
            c.drop_below = v;
        }
        if let Some(n) = env_parse::<usize>("REACTOR_MIN_REPLICAS").filter(|n| *n >= 1) {
            c.min_replicas = n;
        }
        if let Some(n) = env_parse::<u64>("REACTOR_REMOTE_CACHE_BYTES") {
            c.cache_bytes = n;
        }
        c.tls_server = tls::TlsSettings::from_env().is_some();
        c.tls_ca = std::env::var("REACTOR_TLS_CA").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from);
        if let Some(n) = env_parse::<usize>("REACTOR_PULL_CONCURRENCY").filter(|n| (1..=256).contains(n)) {
            c.pull_concurrency = n;
        }
        let t = TransportConfig::from_env().map_err(std::io::Error::other)?;
        c.peer_transport = t.prefer;
        c.quic = t.quic;
        c.tls_identity = t.identity;
        Ok(c)
    }

    /// Peer client settings derived from this configuration.
    pub fn transport_config(&self) -> TransportConfig {
        TransportConfig {
            prefer: self.peer_transport,
            tls_ca: self.tls_ca.clone(),
            identity: self.tls_identity.clone(),
            request_timeout: self.request_timeout,
            connect_timeout: self.connect_timeout,
            fallback_retry: self.fallback_retry,
            quic: self.quic.clone(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct TombstoneEntry {
    pub file_id: String,
    pub deleted_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct DemandEntry {
    pub file_id: String,
    pub score: f64,
}

/// `GET /cluster/inventory` response.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Inventory {
    pub node_id: String,
    pub region: Option<String>,
    /// Inventory version covered by this response (resume with `since=version`).
    pub version: u64,
    /// `added` is the complete file list (the receiver replaces its view).
    pub full: bool,
    /// More delta events are available beyond `version`.
    pub more: bool,
    /// `REACTOR_STORE_MAX_BYTES` (null = unlimited).
    pub capacity: Option<u64>,
    /// Live physical bytes (+ in-flight writes).
    pub used: u64,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub tombstones: Vec<TombstoneEntry>,
    pub demand: Vec<DemandEntry>,
    /// Server clock (used for the next `tsince`).
    pub now_ms: u64,
}

/// One chunk of a peer manifest with its location in the peer's objects.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerChunk {
    #[serde(with = "store::hex_id")]
    pub id: Id,
    pub len: u32,
    #[serde(with = "store::hex_id")]
    pub object_id: Id,
    pub object_offset: u32,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerObject {
    #[serde(with = "store::hex_id")]
    pub object_id: Id,
    pub stored_len: u64,
    pub plain_len: u64,
    pub members: Vec<store::ChunkEntry>,
}

/// `GET /cluster/manifests/:id` response: the manifest plus where the holder keeps each chunk.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PeerManifest {
    #[serde(with = "store::hex_id")]
    pub file_id: Id,
    pub size: u64,
    pub created_ms: u64,
    pub origin: bool,
    pub chunks: Vec<PeerChunk>,
    pub objects: Vec<PeerObject>,
}

impl PeerManifest {
    pub fn manifest(&self) -> Manifest {
        Manifest {
            file_id: self.file_id,
            size: self.size,
            chunks: self.chunks.iter().map(|c| store::ChunkEntry { id: c.id, len: c.len }).collect(),
            created_ms: self.created_ms,
        }
    }

    /// Structural validation of a manifest received from a peer (hashes are verified on use).
    pub fn validate(&self, expect: &Id) -> Result<(), String> {
        if self.file_id != *expect {
            return Err("manifest is for another file".into());
        }
        let mut total = 0u64;
        let objects: HashMap<Id, &PeerObject> = self.objects.iter().map(|o| (o.object_id, o)).collect();
        for o in &self.objects {
            let sum: u64 = o.members.iter().map(|m| m.len as u64).sum();
            if sum != o.plain_len || o.plain_len as usize > store::OBJECT_MAX_PLAIN || o.stored_len as usize > MAX_OBJECT_BYTES {
                return Err(format!("object {} has inconsistent lengths", id_hex(&o.object_id)));
            }
        }
        for c in &self.chunks {
            if c.len == 0 || c.len as usize > store::CHUNK_MAX {
                return Err("chunk length out of range".into());
            }
            let o = objects.get(&c.object_id).ok_or("chunk references an unlisted object")?;
            let mut off = 0u32;
            let mut ok = false;
            for m in &o.members {
                if m.id == c.id && off == c.object_offset && m.len == c.len {
                    ok = true;
                    break;
                }
                off = off.saturating_add(m.len);
            }
            if !ok {
                return Err(format!("chunk {} is not a member of its object at the given offset", id_hex(&c.id)));
            }
            total += c.len as u64;
        }
        if total != self.size {
            return Err(format!("chunk lengths sum to {} but size is {}", total, self.size));
        }
        Ok(())
    }
}

/// `POST /cluster/hold/:id` response.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct HoldResponse {
    pub file_id: String,
    pub node_id: String,
    pub granted: bool,
    /// Lease expiry (holder clock, unix ms); 0 when not granted.
    pub expires_ms: u64,
    pub lease_ms: u64,
    /// The holder took over origin (and the pins) as requested.
    pub origin_accepted: bool,
    pub reason: Option<String>,
}

/// `POST /cluster/unpin/:id` response.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct UnpinResponse {
    pub file_id: String,
    pub node_id: String,
    pub held: bool,
    pub origin: bool,
    pub pins: u64,
    pub deleted: bool,
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, Default)]
struct Demand {
    score: f64,
    last_ms: u64,
}

impl Demand {
    fn at(&self, now: u64, half_life_ms: u64) -> f64 {
        self.score * store::index::decay_factor(self.last_ms, now, half_life_ms)
    }
}

#[derive(Clone, Debug, Default)]
struct Peer {
    url: String,
    node_id: Option<String>,
    region: Option<String>,
    version: u64,
    files: HashSet<Id>,
    demand: HashMap<Id, f64>,
    capacity: Option<u64>,
    used: u64,
    last_ok_ms: Option<u64>,
    last_error: Option<String>,
    last_error_ms: Option<u64>,
    failures: u64,
    is_self: bool,
    tomb_since: u64,
    syncs: u64,
}

impl Peer {
    fn healthy(&self, now: u64, timeout: Duration) -> bool {
        !self.is_self
            && self.failures == 0
            && self.node_id.is_some()
            && self.last_ok_ms.is_some_and(|t| now.saturating_sub(t) <= timeout.as_millis() as u64)
    }
    fn free(&self) -> u64 {
        self.capacity.map(|c| c.saturating_sub(self.used)).unwrap_or(u64::MAX)
    }
}

/// Leases this node granted ("I will not drop file X before T") and files it is dropping.
#[derive(Default, Serialize, Deserialize)]
struct LeaseBook {
    /// file (hex) → [(requesting node, expires_ms)]
    granted: HashMap<String, Vec<(String, u64)>>,
    #[serde(skip)]
    dropping: HashMap<Id, u64>,
}

impl LeaseBook {
    fn active(&self, file: &Id, now: u64) -> bool {
        self.granted.get(&id_hex(file)).is_some_and(|v| v.iter().any(|(_, exp)| *exp > now))
    }
    fn prune(&mut self, now: u64) {
        self.granted.retain(|_, v| {
            v.retain(|(_, exp)| *exp > now);
            !v.is_empty()
        });
        self.dropping.retain(|_, since| now.saturating_sub(*since) < 60_000);
    }
    fn count_active(&self, now: u64) -> usize {
        self.granted.values().map(|v| v.iter().filter(|(_, e)| *e > now).count()).sum()
    }
}

#[derive(Default)]
pub struct Metrics {
    pub gossip_rounds: AtomicU64,
    pub pulls: AtomicU64,
    pub pull_bytes: AtomicU64,
    pub pull_failures: AtomicU64,
    pub drops: AtomicU64,
    pub origin_transfers: AtomicU64,
    pub repairs: AtomicU64,
    pub remote_reads: AtomicU64,
    pub remote_read_bytes: AtomicU64,
    pub remote_objects_fetched: AtomicU64,
    pub remote_fetch_bytes: AtomicU64,
    pub remote_fetch_failures: AtomicU64,
    pub cache_hits: AtomicU64,
    pub tombstones_applied: AtomicU64,
    pub quarantine_repairs: AtomicU64,
    pub quarantine_repair_failures: AtomicU64,
    pub leases_granted: AtomicU64,
    pub leases_refused: AtomicU64,
    pub evictions_confirmed: AtomicU64,
    pub unpins_forwarded: AtomicU64,
}

/// Why a pull was started (metrics).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PullReason {
    Gravity,
    Repair,
    Manual,
}

pub struct Cluster {
    pub cfg: ClusterConfig,
    pub store: Arc<Store>,
    /// Peer requests (QUIC or HTTP(S), see [`transport`]).
    pub transport: PeerClient,
    peers: Mutex<Vec<Peer>>,
    demand: Mutex<HashMap<Id, Demand>>,
    leases: Mutex<LeaseBook>,
    /// Files whose eviction was confirmed by leases (file → valid until ms).
    confirmed: Mutex<HashMap<Id, u64>>,
    cache: Mutex<remote::ObjCache>,
    pulling: Mutex<HashSet<Id>>,
    repairing: Mutex<HashSet<Id>>,
    pub metrics: Metrics,
    me: Weak<Cluster>,
}

impl Cluster {
    /// Builds the cluster, installs the store hooks (eviction policy, read hook, quarantine
    /// hook) and spawns the quarantine-repair worker. Must be called inside a tokio runtime.
    pub fn start(cfg: ClusterConfig, store: Arc<Store>) -> Result<Arc<Cluster>, String> {
        let client = PeerClient::new(cfg.transport_config())?;
        Cluster::start_with_client(cfg, store, client)
    }

    /// [`Cluster::start`] with a peer client shared with recipe gossip.
    pub fn start_with_client(cfg: ClusterConfig, store: Arc<Store>, client: PeerClient) -> Result<Arc<Cluster>, String> {
        if cfg.cluster_token.is_none() {
            return Err("data gravity needs REACTOR_CLUSTER_TOKEN".into());
        }
        let leases = load_leases(&cfg.state_dir);
        let peers = cfg.peers.iter().map(|u| Peer { url: u.clone(), ..Default::default() }).collect();
        let cache = remote::ObjCache::new(cfg.cache_bytes);
        let cluster = Arc::new_cyclic(|me| Cluster {
            cfg,
            store: store.clone(),
            transport: client,
            peers: Mutex::new(peers),
            demand: Mutex::new(HashMap::new()),
            leases: Mutex::new(leases),
            confirmed: Mutex::new(HashMap::new()),
            cache: Mutex::new(cache),
            pulling: Mutex::new(HashSet::new()),
            repairing: Mutex::new(HashSet::new()),
            metrics: Metrics::default(),
            me: me.clone(),
        });
        store.set_eviction_policy(Arc::new(policy::GravityPolicy::new(Arc::downgrade(&cluster))));
        let weak = Arc::downgrade(&cluster);
        store.set_read_hook(Some(Arc::new(move |id: &Id, _bytes: u64| {
            if let Some(c) = weak.upgrade() {
                c.record_demand(id);
            }
        })));
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Id>();
        store.set_quarantine_hook(Some(Arc::new(move |id: Id| {
            let _ = tx.send(id);
        })));
        let weak = Arc::downgrade(&cluster);
        tokio::spawn(async move {
            while let Some(id) = rx.recv().await {
                let Some(c) = weak.upgrade() else { break };
                c.repair_quarantined(id).await;
            }
        });
        Ok(cluster)
    }

    fn arc(&self) -> Option<Arc<Cluster>> {
        self.me.upgrade()
    }

    pub fn token(&self) -> &str {
        self.cfg.cluster_token.as_deref().unwrap_or("")
    }

    fn hl_ms(&self) -> u64 {
        self.cfg.demand_half_life.as_millis() as u64
    }

    /// Configured cluster size (this node + peers that are not this node).
    pub fn cluster_size(&self) -> usize {
        1 + lock(&self.peers).iter().filter(|p| !p.is_self).count()
    }

    /// `REACTOR_MIN_REPLICAS` capped at the configured cluster size.
    pub fn min_replicas_effective(&self) -> usize {
        self.cfg.min_replicas.min(self.cluster_size()).max(1)
    }

    // ---- demand ----------------------------------------------------------------------------

    /// Records one request for `file` (local read, remote read).
    pub fn record_demand(&self, file: &Id) -> f64 {
        let now = now_ms();
        let hl = self.hl_ms();
        let mut m = lock(&self.demand);
        let d = m.entry(*file).or_default();
        d.score = d.at(now, hl) + 1.0;
        d.last_ms = now;
        d.score
    }

    /// Whether a non-held file's demand reached `REACTOR_GRAVITY_PULL` (with a rounding
    /// tolerance: N requests in quick succession decay to slightly less than N).
    pub fn should_pull(&self, demand: f64) -> bool {
        demand + 0.005 >= self.cfg.gravity_pull
    }

    /// Current decayed local demand for `file`.
    pub fn demand(&self, file: &Id) -> f64 {
        let now = now_ms();
        lock(&self.demand).get(file).map(|d| d.at(now, self.hl_ms())).unwrap_or(0.0)
    }

    fn demand_top(&self, n: usize, min: f64) -> Vec<(Id, f64)> {
        let now = now_ms();
        let hl = self.hl_ms();
        let mut v: Vec<(Id, f64)> = lock(&self.demand).iter().map(|(k, d)| (*k, d.at(now, hl))).filter(|(_, s)| *s >= min).collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        v.truncate(n);
        v
    }

    /// Highest demand any healthy peer reports for `file`.
    pub fn peer_demand(&self, file: &Id) -> f64 {
        let now = now_ms();
        lock(&self.peers)
            .iter()
            .filter(|p| p.healthy(now, self.cfg.peer_timeout))
            .filter_map(|p| p.demand.get(file).copied())
            .fold(0.0, f64::max)
    }

    // ---- holders ---------------------------------------------------------------------------

    /// Healthy peers that advertise `file`: `(url, node_id)`, highest peer demand first.
    pub fn holders(&self, file: &Id) -> Vec<(String, String)> {
        let now = now_ms();
        let peers = lock(&self.peers);
        let mut v: Vec<(&Peer, f64)> = peers
            .iter()
            .filter(|p| p.healthy(now, self.cfg.peer_timeout) && p.files.contains(file))
            .map(|p| (p, p.demand.get(file).copied().unwrap_or(0.0)))
            .collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.node_id.cmp(&b.0.node_id)));
        v.into_iter().map(|(p, _)| (p.url.clone(), p.node_id.clone().unwrap_or_default())).collect()
    }

    /// Peers to try for a file: known holders first, then every other reachable peer (the
    /// inventory may lag behind a fresh upload).
    pub fn fetch_candidates(&self, file: &Id) -> Vec<String> {
        let mut out: Vec<String> = self.holders(file).into_iter().map(|h| h.0).collect();
        for p in lock(&self.peers).iter() {
            if !p.is_self && !out.contains(&p.url) {
                out.push(p.url.clone());
            }
        }
        out
    }

    fn healthy_peer_urls(&self) -> Vec<String> {
        let now = now_ms();
        lock(&self.peers).iter().filter(|p| p.healthy(now, self.cfg.peer_timeout)).map(|p| p.url.clone()).collect()
    }

    fn all_peer_urls(&self) -> Vec<String> {
        lock(&self.peers).iter().filter(|p| !p.is_self).map(|p| p.url.clone()).collect()
    }

    // ---- HTTP client helpers ---------------------------------------------------------------

    pub(crate) async fn get_capped(&self, url: &str, cap: usize) -> Result<Vec<u8>, String> {
        self.transport.get(url, self.token(), cap).await
    }

    pub(crate) async fn post_capped(&self, url: &str, cap: usize) -> Result<Vec<u8>, String> {
        self.transport.post(url, self.token(), cap).await
    }

    // ---- inventory -------------------------------------------------------------------------

    /// Builds this node's inventory answer (blocking: reads the index).
    pub fn inventory(&self, since: Option<u64>, tsince: u64) -> Result<Inventory, StoreError> {
        let st = &self.store;
        let cap = st.capacity()?;
        let (_, current) = st.file_events_since(u64::MAX, 0)?;
        let floor = st.file_log_floor()?;
        let delta_ok = matches!(since, Some(s) if s > 0 && s <= current && s.saturating_add(1) >= floor);
        let mut inv = Inventory {
            node_id: self.cfg.node_id.clone(),
            region: self.cfg.region.clone(),
            version: current,
            full: !delta_ok,
            more: false,
            capacity: cap.max_bytes,
            used: cap.live_bytes + cap.inflight_bytes,
            added: Vec::new(),
            removed: Vec::new(),
            tombstones: Vec::new(),
            demand: self.demand_top(DEMAND_ADVERTISED, 0.05).into_iter().map(|(id, s)| DemandEntry { file_id: id_hex(&id), score: s }).collect(),
            now_ms: now_ms(),
        };
        if delta_ok {
            let since = since.unwrap_or(0);
            let (events, version) = st.file_events_since(since, INVENTORY_PAGE)?;
            inv.more = events.len() >= INVENTORY_PAGE;
            inv.version = if inv.more { events.last().map(|e| e.version).unwrap_or(version) } else { version };
            let mut tomb_ids: HashSet<Id> = HashSet::new();
            for e in events {
                match e.kind {
                    store::FileEventKind::Added => inv.added.push(id_hex(&e.file_id)),
                    store::FileEventKind::Removed => {
                        inv.removed.push(id_hex(&e.file_id));
                        tomb_ids.insert(e.file_id);
                    }
                }
            }
            let mut tombs: HashMap<Id, u64> = st.tombstones(tsince)?.into_iter().collect();
            for id in tomb_ids {
                if let Some(ms) = st.tombstone(&id)? {
                    tombs.insert(id, ms);
                }
            }
            inv.tombstones = tombs.into_iter().map(|(id, ms)| TombstoneEntry { file_id: id_hex(&id), deleted_ms: ms }).collect();
        } else {
            let mut after: Option<Id> = None;
            while inv.added.len() < INVENTORY_FULL_MAX {
                let page = st.list_files(after.as_ref(), 10_000)?;
                if page.is_empty() {
                    break;
                }
                after = page.last().map(|m| m.file_id);
                inv.added.extend(page.iter().map(|m| id_hex(&m.file_id)));
            }
            inv.tombstones = st.tombstones(0)?.into_iter().map(|(id, ms)| TombstoneEntry { file_id: id_hex(&id), deleted_ms: ms }).collect();
        }
        Ok(inv)
    }

    /// One inventory gossip round with every peer (concurrently).
    pub async fn gossip_round(&self) {
        let urls = self.all_peer_urls();
        let futs = urls.iter().map(|u| self.sync_peer(u));
        let results = futures_util::future::join_all(futs).await;
        let now = now_ms();
        let mut peers = lock(&self.peers);
        for (url, r) in urls.iter().zip(results) {
            if let Some(p) = peers.iter_mut().find(|p| &p.url == url) {
                match r {
                    Ok(()) => {
                        p.last_ok_ms = Some(now);
                        p.failures = 0;
                        p.last_error = None;
                    }
                    Err(e) => {
                        p.failures += 1;
                        p.last_error = Some(e.chars().take(300).collect());
                        p.last_error_ms = Some(now);
                    }
                }
            }
        }
        drop(peers);
        self.metrics.gossip_rounds.fetch_add(1, Ordering::Relaxed);
    }

    async fn sync_peer(&self, url: &str) -> Result<(), String> {
        for _ in 0..64 {
            let (since, tsince) = {
                let peers = lock(&self.peers);
                let p = peers.iter().find(|p| p.url == url).ok_or("unknown peer")?;
                let full = p.node_id.is_none() || p.version == 0 || p.syncs % self.cfg.full_sync_every.max(1) == 0;
                if full {
                    (0, 0)
                } else {
                    (p.version, p.tomb_since)
                }
            };
            let body = self.get_capped(&format!("{}/cluster/inventory?since={}&tsince={}", url, since, tsince), MAX_INVENTORY_BYTES).await?;
            let inv: Inventory = serde_json::from_slice(&body).map_err(|e| format!("bad inventory JSON: {}", e))?;
            if inv.node_id == self.cfg.node_id {
                if let Some(p) = lock(&self.peers).iter_mut().find(|p| p.url == url) {
                    p.is_self = true;
                }
                return Ok(());
            }
            let tombstones: Vec<(Id, u64)> = inv.tombstones.iter().filter_map(|t| parse_id(&t.file_id).map(|id| (id, t.deleted_ms))).collect();
            let restart = {
                let mut peers = lock(&self.peers);
                let p = peers.iter_mut().find(|p| p.url == url).ok_or("unknown peer")?;
                if !inv.full && p.node_id.as_deref() != Some(inv.node_id.as_str()) {
                    // identity changed under a delta: start over with a full listing
                    p.node_id = None;
                    p.version = 0;
                    true
                } else {
                    p.node_id = Some(inv.node_id.clone());
                    p.region = inv.region.clone();
                    if inv.full {
                        p.files = inv.added.iter().filter_map(|s| parse_id(s)).collect();
                    } else {
                        for s in &inv.added {
                            if let Some(id) = parse_id(s) {
                                p.files.insert(id);
                            }
                        }
                        for s in &inv.removed {
                            if let Some(id) = parse_id(s) {
                                p.files.remove(&id);
                            }
                        }
                    }
                    p.version = inv.version;
                    p.capacity = inv.capacity;
                    p.used = inv.used;
                    p.demand = inv.demand.iter().filter_map(|d| parse_id(&d.file_id).map(|id| (id, d.score))).filter(|(_, s)| s.is_finite()).collect();
                    let slack = (self.cfg.interval.as_millis() as u64 * 2).max(60_000);
                    p.tomb_since = inv.now_ms.saturating_sub(slack);
                    if !inv.more {
                        p.syncs += 1;
                    }
                    false
                }
            };
            if !tombstones.is_empty() {
                self.apply_tombstones(tombstones).await;
            }
            if !restart && !inv.more {
                return Ok(());
            }
        }
        Ok(())
    }

    async fn apply_tombstones(&self, list: Vec<(Id, u64)>) {
        let store = self.store.clone();
        let removed = tokio::task::spawn_blocking(move || {
            let mut removed = Vec::new();
            for (id, ms) in list {
                // skip what we already know
                if store.tombstone(&id).ok().flatten().is_some_and(|cur| cur >= ms) && !store.contains_file(&id).unwrap_or(false) {
                    continue;
                }
                match store.apply_tombstone(&id, ms) {
                    Ok(true) => removed.push(id),
                    Ok(false) => {}
                    Err(e) => tracing::warn!("applying tombstone {}: {}", id_hex(&id), e),
                }
            }
            removed
        })
        .await
        .unwrap_or_default();
        if !removed.is_empty() {
            self.metrics.tombstones_applied.fetch_add(removed.len() as u64, Ordering::Relaxed);
            let mut d = lock(&self.demand);
            for id in &removed {
                d.remove(id);
            }
        }
    }

    // ---- remote manifests & objects ----------------------------------------------------------

    /// Fetches and validates a peer manifest from the first candidate that has it. Refuses
    /// manifests older than a local tombstone (an old replica must not resurrect a delete).
    pub async fn fetch_manifest(&self, file: &Id) -> Result<Option<(PeerManifest, Vec<String>)>, String> {
        let tomb = {
            let store = self.store.clone();
            let f = *file;
            tokio::task::spawn_blocking(move || store.tombstone(&f)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?
        };
        let candidates = self.fetch_candidates(file);
        let mut last_err = None;
        for (i, url) in candidates.iter().enumerate() {
            match self.get_capped(&format!("{}/cluster/manifests/{}", url, id_hex(file)), MAX_MANIFEST_BYTES).await {
                Ok(body) => {
                    let pm: PeerManifest = match serde_json::from_slice(&body) {
                        Ok(m) => m,
                        Err(e) => {
                            last_err = Some(format!("{}: bad manifest JSON: {}", url, e));
                            continue;
                        }
                    };
                    if let Err(e) = pm.validate(file) {
                        last_err = Some(format!("{}: {}", url, e));
                        continue;
                    }
                    if tomb.is_some_and(|ms| pm.created_ms < ms) {
                        return Ok(None);
                    }
                    // holders to fetch objects from: the one that answered first, then the rest
                    let mut order = vec![url.clone()];
                    order.extend(candidates.iter().enumerate().filter(|(j, _)| *j != i).map(|(_, u)| u.clone()));
                    return Ok(Some((pm, order)));
                }
                Err(e) if e.starts_with("HTTP 404") => {}
                Err(e) => last_err = Some(format!("{}: {}", url, e)),
            }
        }
        match last_err {
            Some(e) => Err(e),
            None => Ok(None),
        }
    }

    /// Raw object bytes from the first holder that serves a valid copy, plus its decoded
    /// plaintext (decoded and hash-checked against `object_id`).
    pub(crate) async fn fetch_object(&self, object_id: &Id, holders: &[String]) -> Result<(Vec<u8>, Arc<Vec<u8>>), String> {
        let mut last = String::from("no holders");
        for url in holders {
            match self.get_capped(&format!("{}/cluster/objects/{}", url, id_hex(object_id)), MAX_OBJECT_BYTES).await {
                Ok(raw) => {
                    let store = self.store.clone();
                    let oid = *object_id;
                    let res = tokio::task::spawn_blocking(move || store.decode_object(&oid, &raw).map(|p| (raw, p))).await;
                    match res {
                        Ok(Ok((raw, plain))) => {
                            self.metrics.remote_objects_fetched.fetch_add(1, Ordering::Relaxed);
                            self.metrics.remote_fetch_bytes.fetch_add(raw.len() as u64, Ordering::Relaxed);
                            return Ok((raw, Arc::new(plain)));
                        }
                        Ok(Err(e)) => last = format!("{}: object failed verification: {}", url, e),
                        Err(e) => last = e.to_string(),
                    }
                }
                Err(e) => last = format!("{}: {}", url, e),
            }
            self.metrics.remote_fetch_failures.fetch_add(1, Ordering::Relaxed);
        }
        Err(last)
    }

    /// Decoded, verified object plaintext from the cache or a holder.
    pub(crate) async fn object_plain(&self, object_id: &Id, holders: &[String]) -> Result<Arc<Vec<u8>>, String> {
        if let Some(p) = lock(&self.cache).get(object_id) {
            self.metrics.cache_hits.fetch_add(1, Ordering::Relaxed);
            return Ok(p);
        }
        let (_, plain) = self.fetch_object(object_id, holders).await?;
        lock(&self.cache).put(*object_id, plain.clone());
        Ok(plain)
    }

    // ---- pulls -----------------------------------------------------------------------------

    /// Starts a pull in the background unless one is running (gravity trigger).
    pub fn spawn_pull(&self, file: Id, reason: PullReason) {
        let Some(me) = self.arc() else { return };
        if lock(&self.pulling).contains(&file) {
            return;
        }
        tokio::spawn(async move {
            if let Err(e) = me.pull(&file, reason).await {
                tracing::warn!("pull of {} failed: {}", id_hex(&file), e);
            }
        });
    }

    /// Pulls a full replica of `file` from its holders (manifest + missing objects; chunks
    /// already stored locally are reused). Returns whether a replica was imported.
    pub async fn pull(&self, file: &Id, reason: PullReason) -> Result<bool, String> {
        if !lock(&self.pulling).insert(*file) {
            return Ok(false);
        }
        let r = self.pull_inner(file, reason).await;
        lock(&self.pulling).remove(file);
        if r.is_err() {
            self.metrics.pull_failures.fetch_add(1, Ordering::Relaxed);
        }
        r
    }

    async fn pull_inner(&self, file: &Id, reason: PullReason) -> Result<bool, String> {
        let store = self.store.clone();
        let f = *file;
        if tokio::task::spawn_blocking(move || store.contains_file(&f)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())? {
            return Ok(false);
        }
        let Some((pm, holders)) = self.fetch_manifest(file).await? else {
            return Err("no holder has this file".into());
        };
        let me = self.arc().ok_or("cluster shut down")?;
        let handle = tokio::runtime::Handle::current();
        let concurrency = self.cfg.pull_concurrency.max(1);
        let outcome = tokio::task::spawn_blocking(move || -> Result<store::PutOutcome, String> {
            let mut imp = me.store.begin_import(pm.manifest()).map_err(|e| e.to_string())?;
            let missing: HashSet<Id> = imp.missing_chunks().into_iter().collect();
            // group the missing chunks by the holder's objects
            let mut needed: Vec<Id> = Vec::new();
            let mut seen: HashSet<Id> = HashSet::new();
            for c in &pm.chunks {
                if missing.contains(&c.id) && seen.insert(c.object_id) {
                    needed.push(c.object_id);
                }
            }
            let objects: HashMap<Id, &PeerObject> = pm.objects.iter().map(|o| (o.object_id, o)).collect();
            if needed.iter().any(|o| !objects.contains_key(o)) {
                return Err("manifest lists no such object".into());
            }
            // Objects are fetched `concurrency` at a time (in order, so memory stays bounded at
            // about `concurrency` objects) while this thread imports them.
            enum Got {
                Plain(Arc<Vec<u8>>),
                Raw(Vec<u8>),
            }
            let (tx, mut rx) = tokio::sync::mpsc::channel::<(Id, Result<Got, String>)>(concurrency);
            let fetcher = {
                let me = me.clone();
                let holders = holders.clone();
                handle.spawn(async move {
                    use futures_util::StreamExt;
                    let mut results = futures_util::stream::iter(needed.into_iter().map(|oid| {
                        let me = me.clone();
                        let holders = holders.clone();
                        async move {
                            let cached = lock(&me.cache).get(&oid);
                            let r = match cached {
                                Some(p) => Ok(Got::Plain(p)),
                                None => me.fetch_object(&oid, &holders).await.map(|(raw, _)| Got::Raw(raw)),
                            };
                            (oid, r)
                        }
                    }))
                    .buffered(concurrency);
                    while let Some(item) = results.next().await {
                        let failed = item.1.is_err();
                        if tx.send(item).await.is_err() || failed {
                            break;
                        }
                    }
                })
            };
            let res = (|| {
                while let Some((oid, got)) = rx.blocking_recv() {
                    let o = objects.get(&oid).ok_or("manifest lists no such object")?;
                    match got? {
                        Got::Plain(plain) => {
                            let mut off = 0usize;
                            for m in &o.members {
                                let end = off + m.len as usize;
                                if end > plain.len() {
                                    return Err("cached object shorter than its members".to_string());
                                }
                                imp.add_chunk(&m.id, &plain[off..end]).map_err(|e| e.to_string())?;
                                off = end;
                            }
                        }
                        Got::Raw(raw) => {
                            imp.add_object(&oid, &raw, &o.members).map_err(|e| e.to_string())?;
                        }
                    }
                }
                Ok(())
            })();
            drop(rx);
            fetcher.abort();
            res?;
            imp.commit().map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| e.to_string())??;
        self.metrics.pulls.fetch_add(1, Ordering::Relaxed);
        self.metrics.pull_bytes.fetch_add(outcome.stored_bytes, Ordering::Relaxed);
        if reason == PullReason::Repair {
            self.metrics.repairs.fetch_add(1, Ordering::Relaxed);
        }
        Ok(!outcome.duplicate)
    }

    // ---- maintenance -----------------------------------------------------------------------

    /// One maintenance round: gossip, repair, gravity drops, housekeeping.
    pub async fn maintenance_round(&self) {
        self.gossip_round().await;
        self.repair_pass().await;
        self.drop_pass().await;
        self.housekeeping();
    }

    fn housekeeping(&self) {
        let now = now_ms();
        let hl = self.hl_ms();
        lock(&self.demand).retain(|_, d| d.at(now, hl) >= 0.01);
        lock(&self.leases).prune(now);
        lock(&self.confirmed).retain(|_, until| *until > now);
    }

    async fn local_files(&self) -> Vec<FileMeta> {
        let store = self.store.clone();
        tokio::task::spawn_blocking(move || {
            let mut out = Vec::new();
            let mut after: Option<Id> = None;
            loop {
                let page = store.list_files(after.as_ref(), 10_000).unwrap_or_default();
                if page.is_empty() {
                    break;
                }
                after = page.last().map(|m| m.file_id);
                out.extend(page);
                if out.len() >= INVENTORY_FULL_MAX {
                    break;
                }
            }
            out
        })
        .await
        .unwrap_or_default()
    }

    fn my_free(&self) -> u64 {
        match self.store.capacity() {
            Ok(c) => c.max_bytes.map(|m| m.saturating_sub(c.live_bytes + c.inflight_bytes)).unwrap_or(u64::MAX),
            Err(_) => 0,
        }
    }

    /// Under-replication repair; returns the number of files this node pulled.
    pub async fn repair_pass(&self) -> usize {
        let local: HashSet<Id> = self.local_files().await.into_iter().map(|m| m.file_id).collect();
        let store = self.store.clone();
        let tombs: HashSet<Id> =
            tokio::task::spawn_blocking(move || store.tombstones(0).unwrap_or_default()).await.unwrap_or_default().into_iter().map(|t| t.0).collect();
        let my_free = self.my_free();
        let now = now_ms();
        let todo: Vec<Id> = {
            let peers = lock(&self.peers);
            let healthy: Vec<&Peer> = peers.iter().filter(|p| p.healthy(now, self.cfg.peer_timeout)).collect();
            let target = self.cfg.min_replicas.min(1 + healthy.len());
            let mut universe: HashSet<Id> = HashSet::new();
            for p in &healthy {
                universe.extend(p.files.iter().copied());
            }
            let mut todo = Vec::new();
            let mut files: Vec<Id> = universe.into_iter().filter(|f| !local.contains(f) && !tombs.contains(f)).collect();
            files.sort_unstable();
            for f in files {
                let holders = healthy.iter().filter(|p| p.files.contains(&f)).count();
                if holders == 0 || holders >= target {
                    continue;
                }
                // deterministic leader among healthy non-holders: most free capacity, then
                // smallest node_id
                let mut best: (u64, &str) = (my_free, self.cfg.node_id.as_str());
                for p in healthy.iter().filter(|p| !p.files.contains(&f)) {
                    let nid = p.node_id.as_deref().unwrap_or("");
                    let cand = (p.free(), nid);
                    if cand.0 > best.0 || (cand.0 == best.0 && cand.1 < best.1) {
                        best = cand;
                    }
                }
                if best.1 == self.cfg.node_id {
                    todo.push(f);
                    if todo.len() >= REPAIRS_PER_PASS {
                        break;
                    }
                }
            }
            todo
        };
        let mut n = 0;
        for f in todo {
            match self.pull(&f, PullReason::Repair).await {
                Ok(true) => n += 1,
                Ok(false) => {}
                Err(e) => tracing::warn!("repair of {} failed: {}", id_hex(&f), e),
            }
        }
        n
    }

    /// Gravity drops; returns the number of replicas dropped.
    pub async fn drop_pass(&self) -> usize {
        let mut n = 0;
        for m in self.local_files().await {
            if self.demand(&m.file_id) >= self.cfg.drop_below || self.peer_demand(&m.file_id) < self.cfg.drop_peer_demand {
                continue;
            }
            match self.try_drop(&m).await {
                Ok(true) => n += 1,
                Ok(false) => {}
                Err(e) => tracing::warn!("drop of {} failed: {}", id_hex(&m.file_id), e),
            }
        }
        n
    }

    /// Requests hold-leases from other holders until `need` granted (one of them taking over
    /// origin when `origin_pins` is set). Returns `(granted, origin_accepted)`.
    async fn acquire_leases(&self, pooled: bool, file: &Id, need: usize, origin_pins: Option<u64>) -> (usize, bool) {
        let hold = |url: &str, origin: Option<u64>| {
            let mut q = format!("{}/cluster/hold/{}?node={}", url, id_hex(file), self.cfg.node_id);
            if let Some(pins) = origin {
                q.push_str(&format!("&origin=1&pins={}", pins));
            }
            let fid = id_hex(file);
            async move {
                let body = self.transport.request(Method::POST, &q, self.token(), MAX_SMALL_BYTES, pooled).await.ok()?;
                let h: HoldResponse = serde_json::from_slice(&body).ok()?;
                (h.granted && h.file_id == fid).then_some(h)
            }
        };
        let mut granted: Vec<String> = Vec::new();
        for (url, _) in self.holders(file) {
            if granted.len() >= need {
                break;
            }
            if hold(&url, None).await.is_some() {
                granted.push(url);
            }
        }
        if granted.len() < need {
            return (granted.len(), false);
        }
        // Origin moves only once enough replicas are confirmed (the lease is refreshed).
        let Some(pins) = origin_pins else { return (granted.len(), true) };
        for url in &granted {
            if hold(url, Some(pins)).await.is_some_and(|h| h.origin_accepted) {
                return (granted.len(), true);
            }
        }
        (granted.len(), false)
    }

    /// Drops a local replica if (and only if) enough other holders granted leases.
    pub async fn try_drop(&self, meta: &FileMeta) -> Result<bool, String> {
        let file = meta.file_id;
        let need = self.min_replicas_effective();
        if self.holders(&file).len() < need {
            return Ok(false);
        }
        {
            let mut l = lock(&self.leases);
            let now = now_ms();
            if l.active(&file, now) || l.dropping.contains_key(&file) {
                return Ok(false);
            }
            l.dropping.insert(file, now);
        }
        let origin_pins = if meta.origin && meta.pins > 0 { Some(meta.pins) } else { None };
        let (granted, origin_ok) = self.acquire_leases(true, &file, need, origin_pins).await;
        let res = if granted >= need && origin_ok {
            let store = self.store.clone();
            let dropped = tokio::task::spawn_blocking(move || store.drop_replica(&file)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            if dropped {
                self.metrics.drops.fetch_add(1, Ordering::Relaxed);
                if origin_pins.is_some() {
                    self.metrics.origin_transfers.fetch_add(1, Ordering::Relaxed);
                }
                lock(&self.demand).remove(&file);
            }
            Ok(dropped)
        } else {
            Ok(false)
        };
        lock(&self.leases).dropping.remove(&file);
        res
    }

    /// `POST /cluster/hold/:id` (blocking): grants a lease if this node holds the file and is
    /// not dropping it; optionally takes over origin and the pins.
    pub fn grant_hold(&self, file: &Id, requester: &str, origin: bool, pins: u64) -> HoldResponse {
        let now = now_ms();
        let ttl = self.cfg.lease_ttl.as_millis() as u64;
        let mut resp = HoldResponse {
            file_id: id_hex(file),
            node_id: self.cfg.node_id.clone(),
            granted: false,
            expires_ms: 0,
            lease_ms: ttl,
            origin_accepted: false,
            reason: None,
        };
        let held = matches!(self.store.file_meta(file), Ok(Some(_)));
        if !held {
            resp.reason = Some("not held".into());
            self.metrics.leases_refused.fetch_add(1, Ordering::Relaxed);
            return resp;
        }
        let snapshot = {
            let mut l = lock(&self.leases);
            if l.dropping.contains_key(file) {
                resp.reason = Some("dropping".into());
                self.metrics.leases_refused.fetch_add(1, Ordering::Relaxed);
                return resp;
            }
            let requester: String = requester.chars().filter(|c| c.is_ascii_alphanumeric()).take(64).collect();
            let v = l.granted.entry(id_hex(file)).or_default();
            v.retain(|(n, exp)| *n != requester && *exp > now);
            v.push((requester, now + ttl));
            serde_json::to_vec(&*l).unwrap_or_default()
        };
        if let Err(e) = write_atomic(&leases_path(&self.cfg.state_dir), &snapshot) {
            tracing::warn!("failed to persist leases: {}", e);
        }
        resp.granted = true;
        resp.expires_ms = now + ttl;
        self.metrics.leases_granted.fetch_add(1, Ordering::Relaxed);
        if origin {
            let ok = self.store.set_origin(file, true).unwrap_or(false) && self.store.add_pins(file, pins.min(1 << 32) as i64).is_ok();
            resp.origin_accepted = ok;
        }
        resp
    }

    /// Whether this node promised (lease) not to drop `file`.
    pub fn has_active_lease(&self, file: &Id) -> bool {
        lock(&self.leases).active(file, now_ms())
    }

    /// `POST /cluster/unpin/:id` (blocking): unpin forwarded by a node that does not hold the
    /// file; applied only where the file is a pinned origin.
    pub fn unpin_forwarded(&self, file: &Id) -> UnpinResponse {
        let mut r = UnpinResponse { file_id: id_hex(file), node_id: self.cfg.node_id.clone(), held: false, origin: false, pins: 0, deleted: false };
        if let Ok(Some(m)) = self.store.file_meta(file) {
            r.held = true;
            r.origin = m.origin && m.pins > 0;
            r.pins = m.pins;
            if r.origin {
                if let Ok(Some(out)) = self.store.delete(file) {
                    r.pins = out.pins;
                    r.deleted = out.deleted;
                }
            }
        }
        r
    }

    /// DELETE of a file this node does not hold: forwards the unpin to the holder that owns
    /// origin (after an origin transfer the pins live there).
    pub async fn forward_unpin(&self, file: &Id) -> Option<UnpinResponse> {
        for url in self.fetch_candidates(file) {
            let Ok(body) = self.post_capped(&format!("{}/cluster/unpin/{}", url, id_hex(file)), MAX_SMALL_BYTES).await else { continue };
            let Ok(r) = serde_json::from_slice::<UnpinResponse>(&body) else { continue };
            if r.held && r.origin {
                self.metrics.unpins_forwarded.fetch_add(1, Ordering::Relaxed);
                return Some(r);
            }
        }
        None
    }

    // ---- quarantine repair -----------------------------------------------------------------

    async fn repair_quarantined(&self, oid: Id) {
        match self.repair_object(&oid).await {
            Ok(()) => {
                self.metrics.quarantine_repairs.fetch_add(1, Ordering::Relaxed);
            }
            Err(e) => {
                self.metrics.quarantine_repair_failures.fetch_add(1, Ordering::Relaxed);
                tracing::warn!("could not repair quarantined object {}: {}", id_hex(&oid), e);
            }
        }
    }

    /// Re-fetches a corrupt object: the same object from any peer (raw, verified), else the
    /// member chunks' plaintext (each verified) reassembled.
    pub async fn repair_object(&self, oid: &Id) -> Result<(), String> {
        if !lock(&self.repairing).insert(*oid) {
            return Ok(());
        }
        let r = self.repair_object_inner(oid).await;
        lock(&self.repairing).remove(oid);
        r
    }

    async fn repair_object_inner(&self, oid: &Id) -> Result<(), String> {
        let mut peers = self.healthy_peer_urls();
        for u in self.all_peer_urls() {
            if !peers.contains(&u) {
                peers.push(u);
            }
        }
        if let Ok((raw, _)) = self.fetch_object(oid, &peers).await {
            let store = self.store.clone();
            let id = *oid;
            return tokio::task::spawn_blocking(move || store.repair_object_raw(&id, &raw)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string());
        }
        // fallback: member chunks (the peer may store them in differently fused objects)
        let store = self.store.clone();
        let id = *oid;
        let meta = tokio::task::spawn_blocking(move || store.object_meta(&id))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?
            .ok_or("object no longer indexed")?;
        let mut plain = Vec::with_capacity(meta.plain_len as usize);
        for m in &meta.members {
            let mut got = None;
            for url in &peers {
                if let Ok(b) = self.get_capped(&format!("{}/cluster/chunks/{}", url, id_hex(&m.id)), store::CHUNK_MAX).await {
                    if b.len() == m.len as usize && store::sha256(&b) == m.id {
                        got = Some(b);
                        break;
                    }
                }
            }
            plain.extend_from_slice(&got.ok_or_else(|| format!("no peer has chunk {}", id_hex(&m.id)))?);
        }
        let store = self.store.clone();
        let id = *oid;
        tokio::task::spawn_blocking(move || store.repair_object_plain(&id, &plain)).await.map_err(|e| e.to_string())?.map_err(|e| e.to_string())
    }

    // ---- background loop -------------------------------------------------------------------

    /// Spawns the maintenance loop (every `interval`).
    pub fn spawn_loop(self: Arc<Self>, mut shutdown: tokio::sync::watch::Receiver<bool>) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(self.cfg.interval) => {}
                    _ = shutdown.changed() => break,
                }
                if *shutdown.borrow() {
                    break;
                }
                self.maintenance_round().await;
            }
        })
    }

    // ---- status ----------------------------------------------------------------------------

    /// `(healthy, total)` peers, excluding this node.
    pub fn peer_health(&self) -> (usize, usize) {
        let now = now_ms();
        let peers = lock(&self.peers);
        let others: Vec<&Peer> = peers.iter().filter(|p| !p.is_self).collect();
        (others.iter().filter(|p| p.healthy(now, self.cfg.peer_timeout)).count(), others.len())
    }

    pub fn metrics_json(&self) -> serde_json::Value {
        let m = &self.metrics;
        let ld = |a: &AtomicU64| a.load(Ordering::Relaxed);
        let (cache_bytes, cache_objects) = lock(&self.cache).usage();
        serde_json::json!({
            "gossip_rounds": ld(&m.gossip_rounds),
            "pulls": ld(&m.pulls),
            "pull_bytes": ld(&m.pull_bytes),
            "pull_failures": ld(&m.pull_failures),
            "drops": ld(&m.drops),
            "origin_transfers": ld(&m.origin_transfers),
            "repairs": ld(&m.repairs),
            "remote_reads": ld(&m.remote_reads),
            "remote_read_bytes": ld(&m.remote_read_bytes),
            "remote_objects_fetched": ld(&m.remote_objects_fetched),
            "remote_fetch_bytes": ld(&m.remote_fetch_bytes),
            "remote_fetch_failures": ld(&m.remote_fetch_failures),
            "cache_hits": ld(&m.cache_hits),
            "cache_bytes": cache_bytes,
            "cache_objects": cache_objects,
            "tombstones_applied": ld(&m.tombstones_applied),
            "quarantine_repairs": ld(&m.quarantine_repairs),
            "quarantine_repair_failures": ld(&m.quarantine_repair_failures),
            "leases_granted": ld(&m.leases_granted),
            "leases_refused": ld(&m.leases_refused),
            "leases_active": lock(&self.leases).count_active(now_ms()),
            "evictions_confirmed": ld(&m.evictions_confirmed),
            "unpins_forwarded": ld(&m.unpins_forwarded),
        })
    }

    /// `GET /cluster/status` body.
    pub fn status(&self) -> serde_json::Value {
        let now = now_ms();
        let local: Vec<FileMeta> = self.store.list_files(None, 20).unwrap_or_default();
        let (peers_json, sample_ids): (Vec<serde_json::Value>, Vec<Id>) = {
            let peers = lock(&self.peers);
            let pj = peers
                .iter()
                .map(|p| {
                    serde_json::json!({
                        "url": p.url,
                        "node_id": p.node_id,
                        "region": p.region,
                        "healthy": p.healthy(now, self.cfg.peer_timeout),
                        "is_self": p.is_self,
                        "last_ok_ms": p.last_ok_ms,
                        "last_error": p.last_error,
                        "last_error_ms": p.last_error_ms,
                        "consecutive_failures": p.failures,
                        "inventory_version": p.version,
                        "files": p.files.len(),
                        "capacity": p.capacity,
                        "used": p.used,
                        "transport": self.transport.peer_json(&p.url),
                    })
                })
                .collect();
            let mut ids: Vec<Id> = local.iter().map(|m| m.file_id).collect();
            for p in peers.iter() {
                for f in p.files.iter().take(20) {
                    if ids.len() >= 40 {
                        break;
                    }
                    if !ids.contains(f) {
                        ids.push(*f);
                    }
                }
            }
            (pj, ids)
        };
        let local_set: HashSet<Id> = local.iter().map(|m| m.file_id).collect();
        let sample: Vec<serde_json::Value> = sample_ids
            .iter()
            .map(|f| {
                let is_local = local_set.contains(f) || self.store.contains_file(f).unwrap_or(false);
                let mut holders: Vec<String> = self.holders(f).into_iter().map(|h| h.1).collect();
                if is_local {
                    holders.push(self.cfg.node_id.clone());
                }
                holders.sort();
                serde_json::json!({ "file_id": id_hex(f), "holders": holders, "local": is_local, "demand": self.demand(f) })
            })
            .collect();
        let cap = self.store.capacity().ok();
        serde_json::json!({
            "node_id": self.cfg.node_id,
            "region": self.cfg.region,
            "tls": self.cfg.tls_server,
            "cluster_size": self.cluster_size(),
            "min_replicas": self.cfg.min_replicas,
            "min_replicas_effective": self.min_replicas_effective(),
            "gravity_pull": self.cfg.gravity_pull,
            "demand_half_life_ms": self.hl_ms(),
            "gossip_interval_ms": self.cfg.interval.as_millis() as u64,
            "capacity": cap.and_then(|c| c.max_bytes),
            "used": cap.map(|c| c.live_bytes + c.inflight_bytes),
            "peers": peers_json,
            "holders_sample": sample,
            "demand_top": self.demand_top(20, 0.01).into_iter().map(|(id, s)| serde_json::json!({ "file_id": id_hex(&id), "score": s })).collect::<Vec<_>>(),
            "metrics": self.metrics_json(),
            "transport": self.transport.stats_json(),
            "quic_server": self.cfg.quic_server.as_ref().map(|s| s.json()),
        })
    }
}

fn leases_path(state_dir: &Path) -> PathBuf {
    state_dir.join("cluster-leases.json")
}

fn load_leases(state_dir: &Path) -> LeaseBook {
    let mut book: LeaseBook = std::fs::read(leases_path(state_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    book.prune(now_ms());
    book
}

