/** Shapes from core-reactor/openapi.yaml. Unknown extra fields are preserved at runtime. */

export type Codec = "raw" | "lz4" | "deflate" | "zstd" | "brotli" | "procedural";
export type Filter = "none" | "delta" | "shuffle";

export interface Recipe {
  codec: Codec;
  level: number;
  window_log: number | null;
  filter: Filter;
  stride: 0 | 1 | 2 | 4 | 8;
  dict: string | null;
}

export interface Health {
  status: "online";
  engine: string;
  arch?: string;
  os?: string;
  max_buffer_mb?: number;
  max_output_bytes?: number;
  evolution?: boolean;
  features?: string[];
  [k: string]: unknown;
}

export interface EntropyResult {
  size_bytes: number;
  entropy_bits: number;
  suggested_routing: "raw_bypass" | "symbit" | "lz4_zlib";
}

export interface ClassChampion {
  recipe: Recipe;
  label: string;
  fitness: number;
  ratio: number;
  enc_mib_s: number;
  dec_mib_s: number;
  generation: number;
  origin: string;
}

export interface ClassStatus {
  class: string;
  evolvable: boolean;
  generation: number;
  champion: ClassChampion | null;
  population_size: number;
  samples: number;
  pending_immigrants: number;
  dicts: string[];
  stats: Record<string, number>;
  [k: string]: unknown;
}

export interface PeerStatus {
  url: string;
  last_ok: number | null;
  last_error: string | null;
  last_error_ms: number | null;
  immigrants_received: number;
}

export interface EvolutionStatus {
  enabled: boolean;
  interval_ms: number;
  weights: { encode: number; decode: number };
  classes: ClassStatus[];
  peers?: PeerStatus[];
  gossip_enabled?: boolean;
  share_dictionaries?: boolean;
  [k: string]: unknown;
}

/** `PUT /store/files` response. */
export interface PutResult {
  file_id: string;
  size: number;
  /** Physical bytes of objects newly written by this upload. */
  stored_bytes: number;
  /** Plaintext bytes of the chunks newly stored by this upload (0 when `duplicate`); compression = `new_bytes / stored_bytes`. */
  new_bytes: number;
  /** Chunks not previously stored (0 when `duplicate`). */
  new_chunks: number;
  /** Chunks already stored (all chunks when `duplicate`). */
  dedup_chunks: number;
  /** Total chunks of the file. */
  chunks: number;
  /** Content class, e.g. `text/json`, `media/compressed`, `empty`. */
  class: string;
  /** The file was already stored; only its pin count changed. */
  duplicate: boolean;
  /** Pin count after this upload. */
  pins: number;
}

/** `DELETE /store/files/:id` response. */
export interface DeleteResult {
  file_id: string;
  /** Remaining pin count (0 when deleted). */
  pins: number;
  /** The manifest was removed and a tombstone written. */
  deleted: boolean;
  /**
   * Node id of the peer the unpin was forwarded to (the file's origin holder) when this node did
   * not hold the file itself (data gravity, NETWORK_SPEC §4).
   */
  forwarded_to?: string;
}

/** Body of a 507 from `PUT /store/files` (see `InsufficientStorageError.storeFull`). */
export interface StoreFull {
  error: "store full";
  /** Physical bytes the upload needed. */
  needed: number;
  /** Physical bytes of live objects. */
  used: number;
  /** `REACTOR_STORE_MAX_BYTES`. */
  max: number;
}

export interface StoreGcStats {
  queue_objects: number;
  queue_bytes: number;
  grace_ms: number;
  collected_objects: number;
  collected_bytes: number;
  startup_orphans_removed: number;
  startup_temp_files_removed: number;
}

export interface StoreFusionStats {
  enabled: boolean;
  fusions: number;
  unfusions: number;
  bytes_saved: number;
  reads_saved: number;
  candidates_evaluated: number;
  rejected: number;
  last_run_ms: number;
  access_rows: number;
  coaccess_min: number;
}

export interface StoreScrubStats {
  objects_checked: number;
  bytes_checked: number;
  corrupt_found: number;
  passes_completed: number;
  pass_progress_objects: number;
  last_step_ms: number;
  last_pass_ms: number;
  quarantined: number;
}

/** `GET /store/stats` response. */
export interface StoreStats {
  files: number;
  logical_bytes: number;
  unique_bytes: number;
  physical_bytes: number;
  live_physical_bytes: number;
  /** `REACTOR_STORE_MAX_BYTES`; null = unlimited. */
  max_bytes: number | null;
  dedup_ratio: number;
  compression_ratio: number;
  total_ratio: number;
  objects: number;
  super_chunks: number;
  chunks: number;
  tombstones: number;
  inventory_version: number;
  inflight_bytes: number;
  puts: number;
  put_bytes: number;
  reads: number;
  read_bytes: number;
  full_rejections: number;
  evictions: number;
  gc: StoreGcStats;
  fusion: StoreFusionStats;
  scrub: StoreScrubStats;
  /** Group-commit counters (absent on reactors that predate them). */
  group_commit?: StoreGroupCommitStats;
  /** Data-gravity counters; present only when the cluster is enabled (`REACTOR_CLUSTER_TOKEN`). */
  cluster?: ClusterMetrics;
  /** Pack-file stats (loosely typed; shape not final yet). */
  packs?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Group commit of concurrent uploads (one index transaction per batch). */
export interface StoreGroupCommitStats {
  batches: number;
  jobs: number;
  max_batch: number;
  window_ms: number;
}

/** Data-gravity counters (`/cluster/status` `metrics` and `/store/stats` `cluster`). */
export interface ClusterMetrics {
  gossip_rounds: number;
  pulls: number;
  pull_bytes: number;
  pull_failures: number;
  drops: number;
  origin_transfers: number;
  repairs: number;
  remote_reads: number;
  remote_read_bytes: number;
  remote_objects_fetched: number;
  remote_fetch_bytes: number;
  remote_fetch_failures: number;
  cache_hits: number;
  cache_bytes: number;
  cache_objects: number;
  tombstones_applied: number;
  quarantine_repairs: number;
  quarantine_repair_failures: number;
  leases_granted: number;
  leases_refused: number;
  leases_active: number;
  evictions_confirmed: number;
  unpins_forwarded: number;
}

/** One configured peer as seen by this node. */
export interface ClusterPeer {
  url: string;
  /** null until the first successful inventory fetch. */
  node_id: string | null;
  region: string | null;
  /** Last inventory fetch succeeded and is younger than 3 × the gossip interval. */
  healthy: boolean;
  /** The URL points back at this node. */
  is_self: boolean;
  last_ok_ms: number | null;
  last_error: string | null;
  last_error_ms: number | null;
  consecutive_failures: number;
  inventory_version: number;
  /** Files the peer advertises. */
  files: number;
  capacity: number | null;
  used: number;
}

/** Sampled replica placement. */
export interface FileHolders {
  file_id: string;
  /** Node ids holding a replica (sorted; includes this node when `local`). */
  holders: string[];
  local: boolean;
  /** Local demand score. */
  demand: number;
}

export interface DemandEntry {
  file_id: string;
  /** Exponentially decayed request count. */
  score: number;
}

/** `GET /cluster/status` response (auth `x-reactor-token`). */
export interface ClusterStatus {
  node_id: string;
  region: string | null;
  /** This node serves HTTPS. */
  tls: boolean;
  /** This node plus its non-self peers. */
  cluster_size: number;
  /** `REACTOR_MIN_REPLICAS`. */
  min_replicas: number;
  /** `min(min_replicas, cluster_size)`. */
  min_replicas_effective: number;
  /** `REACTOR_GRAVITY_PULL`. */
  gravity_pull: number;
  demand_half_life_ms: number;
  gossip_interval_ms: number;
  /** `REACTOR_STORE_MAX_BYTES` (null = unlimited). */
  capacity: number | null;
  /** Live physical + in-flight bytes (null if unavailable). */
  used: number | null;
  peers: ClusterPeer[];
  holders_sample: FileHolders[];
  demand_top: DemandEntry[];
  metrics: ClusterMetrics;
  [k: string]: unknown;
}

export interface Tombstone {
  file_id: string;
  deleted_ms: number;
}

/** `GET /cluster/inventory` (internal, see `ClusterAdmin`). */
export interface Inventory {
  node_id: string;
  region: string | null;
  /** Version covered by this response (resume with `since = version`). */
  version: number;
  /** `added` is the complete file list. */
  full: boolean;
  /** More delta events are available beyond `version`. */
  more: boolean;
  capacity: number | null;
  used: number;
  added: string[];
  removed: string[];
  tombstones: Tombstone[];
  demand: DemandEntry[];
  /** Server clock (use as the next `tsince`). */
  now_ms: number;
}

/** `POST /cluster/hold/:id` (internal, see `ClusterAdmin`). */
export interface HoldResult {
  file_id: string;
  /** The holder's node id. */
  node_id: string;
  granted: boolean;
  /** Lease expiry (holder clock, unix ms); 0 when not granted. */
  expires_ms: number;
  lease_ms: number;
  /** The holder took over origin (and the pins) as requested. */
  origin_accepted: boolean;
  /** Why the lease was refused (`"not held"`, `"dropping"`). */
  reason: string | null;
}

export interface CompressMeta {
  /** `x-reactor-class` */
  contentClass: string;
  /** Parsed `x-reactor-recipe`; null for legacy raw output. */
  recipe: Recipe | null;
  /** `x-reactor-format`: `v2` or `legacy-raw`. */
  format: string;
  originalSize: number;
  compressedSize: number;
  algo: string;
  ratio: number;
  timeUs: number;
  entropy: number;
  note?: string;
  headers: Headers;
}

export interface CompressResult extends CompressMeta {
  data: Uint8Array;
}

export interface CompressStreamResult extends CompressMeta {
  body: ReadableStream<Uint8Array>;
}

export interface RangeInfo {
  /** 200 (whole file) or 206 (range). */
  status: number;
  /** First byte offset served (inclusive). */
  start: number;
  /** Last byte offset served (inclusive); -1 for an empty body. */
  end: number;
  /** Full file size, when known. */
  total: number | undefined;
  /** Length of the body (from Content-Length; undefined when chunked and not yet read). */
  length: number | undefined;
  /** Strong ETag (the quoted lowercase file id). */
  etag: string | null;
  headers: Headers;
}

export interface GetResult extends RangeInfo {
  data: Uint8Array;
}

export interface GetStreamResult extends RangeInfo {
  body: ReadableStream<Uint8Array>;
}

export interface HeadResult {
  size: number;
  acceptRanges: string | null;
  /** Strong ETag (the quoted lowercase file id). */
  etag: string | null;
  headers: Headers;
}
