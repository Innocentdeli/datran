//! Response shapes from `core-reactor/openapi.yaml`. Unknown fields are kept in `extra`.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

/// Compression recipe (EVOLUTION_SPEC §2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recipe {
    pub codec: String,
    #[serde(default)]
    pub level: i32,
    #[serde(default)]
    pub window_log: Option<u32>,
    #[serde(default = "default_filter")]
    pub filter: String,
    #[serde(default)]
    pub stride: u8,
    #[serde(default)]
    pub dict: Option<String>,
}

fn default_filter() -> String {
    "none".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Health {
    pub status: String,
    pub engine: String,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub max_output_bytes: Option<u64>,
    #[serde(default)]
    pub evolution: Option<bool>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Entropy {
    pub size_bytes: u64,
    pub entropy_bits: f64,
    pub suggested_routing: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassChampion {
    pub recipe: Recipe,
    #[serde(default)]
    pub label: String,
    pub fitness: f64,
    #[serde(default)]
    pub ratio: f64,
    #[serde(default)]
    pub enc_mib_s: f64,
    #[serde(default)]
    pub dec_mib_s: f64,
    #[serde(default)]
    pub generation: u64,
    #[serde(default)]
    pub origin: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClassStatus {
    pub class: String,
    #[serde(default)]
    pub evolvable: bool,
    pub generation: u64,
    pub champion: Option<ClassChampion>,
    pub population_size: u64,
    pub samples: u64,
    #[serde(default)]
    pub pending_immigrants: u64,
    #[serde(default)]
    pub dicts: Vec<String>,
    #[serde(default)]
    pub stats: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Weights {
    pub encode: f64,
    pub decode: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerStatus {
    pub url: String,
    pub last_ok: Option<u64>,
    pub last_error: Option<String>,
    #[serde(default)]
    pub last_error_ms: Option<u64>,
    #[serde(default)]
    pub immigrants_received: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EvolutionStatus {
    pub enabled: bool,
    pub interval_ms: u64,
    pub weights: Weights,
    pub classes: Vec<ClassStatus>,
    #[serde(default)]
    pub peers: Vec<PeerStatus>,
    #[serde(default)]
    pub gossip_enabled: bool,
    #[serde(default)]
    pub share_dictionaries: bool,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// `PUT /store/files` response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PutResult {
    pub file_id: String,
    pub size: u64,
    /// Physical bytes of objects newly written by this upload.
    pub stored_bytes: u64,
    /// Plaintext bytes of the chunks newly stored by this upload (0 when `duplicate`);
    /// compression of this upload = `new_bytes / stored_bytes`.
    pub new_bytes: u64,
    /// Chunks not previously stored (0 when `duplicate`).
    pub new_chunks: u64,
    /// Chunks already stored (all chunks when `duplicate`).
    pub dedup_chunks: u64,
    /// Total chunks of the file.
    pub chunks: u64,
    /// Content class, e.g. `text/json`, `media/compressed`, `empty`.
    pub class: String,
    /// The file was already stored; only its pin count changed.
    pub duplicate: bool,
    /// Pin count after this upload.
    pub pins: u64,
}

/// `DELETE /store/files/:id` response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteResult {
    pub file_id: String,
    /// Remaining pin count (0 when deleted).
    pub pins: u64,
    /// The manifest was removed and a tombstone written.
    pub deleted: bool,
    /// Node id of the peer the unpin was forwarded to (the file's origin holder) when this node did
    /// not hold the file itself (data gravity, NETWORK_SPEC §4).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forwarded_to: Option<String>,
}

/// Body of a 507 from `PUT /store/files` (see [`crate::ApiError::store_full`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreFull {
    pub error: String,
    /// Physical bytes the upload needed.
    pub needed: u64,
    /// Physical bytes of live objects.
    pub used: u64,
    /// `REACTOR_STORE_MAX_BYTES`.
    pub max: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreGcStats {
    pub queue_objects: u64,
    pub queue_bytes: u64,
    pub grace_ms: u64,
    pub collected_objects: u64,
    pub collected_bytes: u64,
    pub startup_orphans_removed: u64,
    pub startup_temp_files_removed: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreFusionStats {
    pub enabled: bool,
    pub fusions: u64,
    pub unfusions: u64,
    pub bytes_saved: u64,
    pub reads_saved: u64,
    pub candidates_evaluated: u64,
    pub rejected: u64,
    pub last_run_ms: u64,
    pub access_rows: u64,
    pub coaccess_min: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StoreScrubStats {
    pub objects_checked: u64,
    pub bytes_checked: u64,
    pub corrupt_found: u64,
    pub passes_completed: u64,
    pub pass_progress_objects: u64,
    pub last_step_ms: u64,
    pub last_pass_ms: u64,
    pub quarantined: u64,
}

/// `GET /store/stats` response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreStats {
    pub files: u64,
    pub logical_bytes: u64,
    pub unique_bytes: u64,
    pub physical_bytes: u64,
    pub live_physical_bytes: u64,
    /// `REACTOR_STORE_MAX_BYTES`; `None` = unlimited.
    pub max_bytes: Option<u64>,
    pub dedup_ratio: f64,
    pub compression_ratio: f64,
    pub total_ratio: f64,
    pub objects: u64,
    pub super_chunks: u64,
    pub chunks: u64,
    pub tombstones: u64,
    pub inventory_version: u64,
    pub inflight_bytes: u64,
    pub puts: u64,
    pub put_bytes: u64,
    pub reads: u64,
    pub read_bytes: u64,
    pub full_rejections: u64,
    pub evictions: u64,
    pub gc: StoreGcStats,
    pub fusion: StoreFusionStats,
    pub scrub: StoreScrubStats,
    /// Group-commit counters (`None` on reactors that predate them).
    #[serde(default)]
    pub group_commit: Option<StoreGroupCommitStats>,
    /// Data-gravity counters; present only when the cluster is enabled (`REACTOR_CLUSTER_TOKEN`).
    #[serde(default)]
    pub cluster: Option<ClusterMetrics>,
    /// Pack-file stats (loosely typed; shape not final yet).
    #[serde(default)]
    pub packs: Option<Map<String, Value>>,
}

/// Group commit of concurrent uploads (one index transaction per batch).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreGroupCommitStats {
    pub batches: u64,
    pub jobs: u64,
    pub max_batch: u64,
    pub window_ms: f64,
}

/// Data-gravity counters (`/cluster/status` `metrics` and `/store/stats` `cluster`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClusterMetrics {
    pub gossip_rounds: u64,
    pub pulls: u64,
    pub pull_bytes: u64,
    pub pull_failures: u64,
    pub drops: u64,
    pub origin_transfers: u64,
    pub repairs: u64,
    pub remote_reads: u64,
    pub remote_read_bytes: u64,
    pub remote_objects_fetched: u64,
    pub remote_fetch_bytes: u64,
    pub remote_fetch_failures: u64,
    pub cache_hits: u64,
    pub cache_bytes: u64,
    pub cache_objects: u64,
    pub tombstones_applied: u64,
    pub quarantine_repairs: u64,
    pub quarantine_repair_failures: u64,
    pub leases_granted: u64,
    pub leases_refused: u64,
    pub leases_active: u64,
    pub evictions_confirmed: u64,
    pub unpins_forwarded: u64,
}

/// One configured peer as seen by this node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClusterPeer {
    pub url: String,
    /// `None` until the first successful inventory fetch.
    pub node_id: Option<String>,
    pub region: Option<String>,
    /// Last inventory fetch succeeded and is younger than 3 × the gossip interval.
    pub healthy: bool,
    /// The URL points back at this node.
    pub is_self: bool,
    pub last_ok_ms: Option<u64>,
    pub last_error: Option<String>,
    pub last_error_ms: Option<u64>,
    pub consecutive_failures: u64,
    pub inventory_version: u64,
    /// Files the peer advertises.
    pub files: u64,
    pub capacity: Option<u64>,
    pub used: u64,
}

/// Sampled replica placement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FileHolders {
    pub file_id: String,
    /// Node ids holding a replica (sorted; includes this node when `local`).
    pub holders: Vec<String>,
    pub local: bool,
    /// Local demand score.
    pub demand: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Demand {
    pub file_id: String,
    /// Exponentially decayed request count.
    pub score: f64,
}

/// `GET /cluster/status` response (auth `x-reactor-token`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ClusterStatus {
    pub node_id: String,
    pub region: Option<String>,
    /// This node serves HTTPS.
    pub tls: bool,
    /// This node plus its non-self peers.
    pub cluster_size: u64,
    /// `REACTOR_MIN_REPLICAS`.
    pub min_replicas: u64,
    /// `min(min_replicas, cluster_size)`.
    pub min_replicas_effective: u64,
    /// `REACTOR_GRAVITY_PULL`.
    pub gravity_pull: f64,
    pub demand_half_life_ms: u64,
    pub gossip_interval_ms: u64,
    /// `REACTOR_STORE_MAX_BYTES` (`None` = unlimited).
    pub capacity: Option<u64>,
    /// Live physical + in-flight bytes (`None` if unavailable).
    pub used: Option<u64>,
    pub peers: Vec<ClusterPeer>,
    pub holders_sample: Vec<FileHolders>,
    pub demand_top: Vec<Demand>,
    pub metrics: ClusterMetrics,
}

impl ClusterStatus {
    /// The peer with this node id, if known.
    pub fn peer(&self, node_id: &str) -> Option<&ClusterPeer> {
        self.peers.iter().find(|p| p.node_id.as_deref() == Some(node_id))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tombstone {
    pub file_id: String,
    pub deleted_ms: u64,
}

/// `GET /cluster/inventory` (internal, see [`crate::ClusterAdmin`]).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Inventory {
    pub node_id: String,
    pub region: Option<String>,
    /// Version covered by this response (resume with `since = version`).
    pub version: u64,
    /// `added` is the complete file list.
    pub full: bool,
    /// More delta events are available beyond `version`.
    pub more: bool,
    pub capacity: Option<u64>,
    pub used: u64,
    pub added: Vec<String>,
    pub removed: Vec<String>,
    pub tombstones: Vec<Tombstone>,
    pub demand: Vec<Demand>,
    /// Server clock (use as the next `tsince`).
    pub now_ms: u64,
}

/// `POST /cluster/hold/:id` (internal, see [`crate::ClusterAdmin`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoldResult {
    pub file_id: String,
    /// The holder's node id.
    pub node_id: String,
    pub granted: bool,
    /// Lease expiry (holder clock, unix ms); 0 when not granted.
    pub expires_ms: u64,
    pub lease_ms: u64,
    /// The holder took over origin (and the pins) as requested.
    pub origin_accepted: bool,
    /// Why the lease was refused (`"not held"`, `"dropping"`).
    pub reason: Option<String>,
}

/// Headers of a `/compress` response.
#[derive(Debug, Clone, Default)]
pub struct CompressMeta {
    /// `x-reactor-class`
    pub content_class: String,
    /// Parsed `x-reactor-recipe`; `None` for legacy raw output.
    pub recipe: Option<Recipe>,
    /// `x-reactor-format`: `v2` or `legacy-raw`.
    pub format: String,
    pub original_size: u64,
    pub compressed_size: u64,
    pub algo: String,
    pub ratio: f64,
    pub time_us: u64,
    pub entropy: f64,
    pub note: Option<String>,
}

#[derive(Debug, Clone)]
pub struct CompressResult {
    pub meta: CompressMeta,
    pub data: bytes::Bytes,
}

/// Which bytes of a stored file were served.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RangeInfo {
    /// 200 (whole file) or 206 (range).
    pub status: u16,
    /// First byte offset (inclusive).
    pub start: u64,
    /// Last byte offset (inclusive); `None` for an empty body or unknown length.
    pub end: Option<u64>,
    /// Full file size, when known.
    pub total: Option<u64>,
    /// Body length from `Content-Length`, when sent.
    pub length: Option<u64>,
    /// Strong ETag (the quoted lowercase file id), when sent.
    pub etag: Option<String>,
}

#[derive(Debug, Clone)]
pub struct GetResult {
    pub info: RangeInfo,
    pub data: bytes::Bytes,
}

#[derive(Debug, Clone)]
pub struct HeadResult {
    pub size: u64,
    pub accept_ranges: Option<String>,
    /// Strong ETag (the quoted lowercase file id).
    pub etag: Option<String>,
}
