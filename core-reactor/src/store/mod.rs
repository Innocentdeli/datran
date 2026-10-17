//! Chunked, deduplicating, content-addressed object store with self-rewriting layout
//! (NETWORK_SPEC §2 and §3).
//!
//! Layout: `<dir>/index.redb` (ACID index) + `<dir>/packs/<pack_id>.pack` (append-only pack files
//! holding small objects as CRC-framed records, see [`pack`]) + `<dir>/objects/<aa>/<object_id>.obj`
//! (objects ≥ the pack threshold, and every object written before packing existed)
//! + `<dir>/quarantine/` (corrupt objects moved aside by the scrubber).
//!
//! Module map:
//! - [`index`]: redb tables and binary records.
//! - `ingest`: streaming FastCDC ingestion (`put_reader`) and replica import ([`Import`]).
//! - `read`: range-aware verified reads.
//! - `gc`: unpin / tombstones / replica drop / garbage collection / capacity & eviction.
//! - `scrub`: background integrity scrub, quarantine and repair.
//! - `fusion`: access tracking, chunk fusion and unfusion.
//! - [`http`]: `/store/*` endpoints.
//!
//! Invariants (checked by [`Store::verify_index`]):
//! - `chunk_loc[c].refs` = number of manifest occurrences of chunk `c`.
//! - `objects[o].refcount` = number of `chunk_loc` entries with refs > 0 pointing at `o`;
//!   refcount 0 ⇔ `o` is in `gc_queue`.
//! - every `chunk_loc` entry points at an indexed object that lists the chunk as a member.
//! - every indexed object has its file on disk or its record in a pack below the pack's committed
//!   end (unless quarantined); files without a row are orphans and are swept on startup.
//! - `packs[p]` live bytes / objects = the records of indexed objects located in pack `p`.
//!
//! Concurrency: redb serializes write transactions. Anything that relies on an object staying on
//! disk *reserves* the ids involved first (in-memory counted set); GC never deletes an object that
//! is reserved or one of whose members is reserved, and it checks the reservation set while holding
//! the reservation lock across its commit and file deletion.

pub mod fusion;
pub mod gc;
mod group;
pub mod http;
pub mod index;
pub mod ingest;
pub mod pack;
pub mod read;
pub mod scrub;

use crate::classify;
use crate::codec::{self, Codec, DecodeError, DictId, HEADER_LEN};
use crate::evolution::Engine;
use crate::recipe::Recipe;
use crate::state::now_ms;
use index::{meta, ObjectRec, PackLoc, Tables};
use redb::{Database, ReadableDatabase, ReadableTable, ReadableTableMetadata};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::Duration;

pub use fusion::FusionReport;
pub use gc::{DeleteOutcome, EvictionPolicy, GcReport, PinnedOriginPolicy};
pub use ingest::{Import, PutOptions, PutOutcome};
pub use pack::{CompactReport, ObjectStorage};
pub use scrub::{ScrubReport, ScrubStatus};

/// SHA-256 id (file, chunk or object).
pub type Id = [u8; 32];

pub const CDC_MIN: usize = 16 * 1024;
pub const CDC_AVG: usize = 64 * 1024;
pub const CDC_MAX: usize = 256 * 1024;
/// Hard cap on an object's plaintext (decode limit); super-chunks are ≤ `fuse_max_run`.
pub const OBJECT_MAX_PLAIN: usize = 16 << 20;
/// Hard cap on a single chunk accepted from a peer manifest.
pub const CHUNK_MAX: usize = 16 << 20;

pub fn id_hex(id: &Id) -> String {
    hex::encode(id)
}

pub fn parse_id(s: &str) -> Option<Id> {
    if s.len() != 64 || !s.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    hex::decode(s).ok()?.try_into().ok()
}

pub fn sha256(data: &[u8]) -> Id {
    codec::sha256(data)
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn class_code(class: &str) -> u8 {
    classify::CLASSES.iter().position(|c| *c == class).map(|i| i as u8).unwrap_or(u8::MAX)
}

fn class_name(code: u8) -> &'static str {
    classify::CLASSES.get(code as usize).copied().unwrap_or(classify::BINARY_STRUCTURED)
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

#[derive(Debug)]
pub enum StoreError {
    NotFound,
    /// Capacity exhausted and nothing could be evicted (HTTP 507).
    Full { needed: u64, used: u64, max: u64 },
    /// Stored data failed verification (the object is quarantined).
    Corrupt(String),
    /// Bad input (manifest, object or chunk from a caller / peer).
    Invalid(String),
    /// A blob references a zstd dictionary this node does not have.
    UnknownDict(DictId),
    Io(std::io::Error),
    Db(String),
    /// Test-only simulated crash at a named fail point.
    Injected(&'static str),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound => write!(f, "not found"),
            StoreError::Full { needed, used, max } => {
                write!(f, "store full: need {} bytes, {} of {} bytes used", needed, used, max)
            }
            StoreError::Corrupt(m) => write!(f, "corrupt data: {}", m),
            StoreError::Invalid(m) => write!(f, "invalid input: {}", m),
            StoreError::UnknownDict(id) => write!(f, "unknown dictionary {}", hex::encode(id)),
            StoreError::Io(e) => write!(f, "I/O error: {}", e),
            StoreError::Db(m) => write!(f, "index error: {}", m),
            StoreError::Injected(p) => write!(f, "injected failure at {}", p),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

macro_rules! db_err {
    ($($t:ty),*) => {$(
        impl From<$t> for StoreError {
            fn from(e: $t) -> Self { StoreError::Db(e.to_string()) }
        }
    )*};
}
db_err!(redb::Error, redb::DatabaseError, redb::TransactionError, redb::TableError, redb::StorageError, redb::CommitError);

impl From<DecodeError> for StoreError {
    fn from(e: DecodeError) -> Self {
        match e {
            DecodeError::UnknownDict(id) => StoreError::UnknownDict(id),
            DecodeError::Invalid(m) => StoreError::Corrupt(m),
        }
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct StoreConfig {
    pub dir: PathBuf,
    /// `REACTOR_STORE_MAX_BYTES` (physical bytes of live objects); `None` = unlimited.
    pub max_bytes: Option<u64>,
    /// `REACTOR_GC_GRACE_MS` (default 10 min).
    pub gc_grace: Duration,
    pub gc_interval: Duration,
    /// `REACTOR_SCRUB_INTERVAL_MS` (default 60 s) and `REACTOR_SCRUB_BYTES` per slice (default 64 MiB).
    pub scrub_interval: Duration,
    pub scrub_bytes: u64,
    /// `REACTOR_FUSION` (default on) and `REACTOR_FUSE_INTERVAL_MS` (default 10 min).
    pub fusion: bool,
    pub fusion_interval: Duration,
    /// `REACTOR_FUSE_COACCESS_MIN` (default 8).
    pub coaccess_min: f64,
    /// Super-chunk plaintext cap (4 MiB).
    pub fuse_max_run: usize,
    /// Required size gain for a structural fusion (0.05).
    pub fuse_min_gain: f64,
    /// Super-chunks larger than this may be unfused (1 MiB).
    pub unfuse_min_bytes: u64,
    pub fuse_max_candidates: usize,
    /// `REACTOR_ACCESS_HALFLIFE_MS` (default 24 h) for the co-access counters.
    pub access_half_life: Duration,
    pub access_flush_interval: Duration,
    pub tombstone_ttl: Duration,
    /// `REACTOR_GROUP_COMMIT_MS` (default 2 ms): how long a group-commit leader waits for other
    /// writers that are still staging before committing the batch (0 = never wait).
    pub group_commit_window: Duration,
    /// `REACTOR_PACK_THRESHOLD` (default 128 KiB): objects whose stored size is below this go into
    /// pack files; 0 disables packing (every object is its own file).
    pub pack_threshold: usize,
    /// `REACTOR_PACK_MAX_BYTES` (default 256 MiB): the active pack is sealed at this size.
    pub pack_max_bytes: u64,
    /// Sealed packs whose live bytes fall below this fraction of their data are compacted (0.5).
    pub pack_compact_ratio: f64,
    /// `REACTOR_COMPRESS_THREADS` (default: every core): ≤ 1 compresses an upload's chunks inline
    /// (sequential); > 1 sends them to the process-wide pool ([`crate::workers`]).
    pub compress_threads: usize,
    /// `REACTOR_INGEST_INFLIGHT_BYTES` (default 64 MiB): per upload, plaintext bytes of chunks
    /// handed to the pool but not yet staged (their encoded results are at most that size again).
    pub ingest_inflight_bytes: u64,
}

fn env_parse<T: std::str::FromStr>(name: &str) -> Option<T> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

impl StoreConfig {
    pub fn new(dir: impl Into<PathBuf>) -> StoreConfig {
        StoreConfig {
            dir: dir.into(),
            max_bytes: None,
            gc_grace: Duration::from_secs(600),
            gc_interval: Duration::from_secs(30),
            scrub_interval: Duration::from_secs(60),
            scrub_bytes: 64 << 20,
            fusion: true,
            fusion_interval: Duration::from_secs(600),
            coaccess_min: 8.0,
            fuse_max_run: 4 << 20,
            fuse_min_gain: 0.05,
            unfuse_min_bytes: 1 << 20,
            fuse_max_candidates: 256,
            access_half_life: Duration::from_secs(24 * 3600),
            access_flush_interval: Duration::from_secs(30),
            tombstone_ttl: Duration::from_secs(30 * 24 * 3600),
            group_commit_window: group::DEFAULT_WINDOW,
            pack_threshold: pack::DEFAULT_THRESHOLD,
            pack_max_bytes: pack::DEFAULT_MAX_BYTES,
            pack_compact_ratio: 0.5,
            compress_threads: crate::workers::configured_threads(),
            ingest_inflight_bytes: 64 << 20,
        }
    }

    /// `$REACTOR_STATE_DIR/store` plus the env overrides documented on the fields.
    pub fn from_env(state_dir: &Path) -> StoreConfig {
        let mut c = StoreConfig::new(state_dir.join("store"));
        c.max_bytes = env_parse::<u64>("REACTOR_STORE_MAX_BYTES").filter(|n| *n > 0);
        if let Some(ms) = env_parse::<u64>("REACTOR_GC_GRACE_MS") {
            c.gc_grace = Duration::from_millis(ms);
        }
        if let Some(ms) = env_parse::<u64>("REACTOR_SCRUB_INTERVAL_MS") {
            c.scrub_interval = Duration::from_millis(ms.max(100));
        }
        if let Some(n) = env_parse::<u64>("REACTOR_SCRUB_BYTES").filter(|n| *n > 0) {
            c.scrub_bytes = n;
        }
        if let Ok(v) = std::env::var("REACTOR_FUSION") {
            c.fusion = !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off");
        }
        if let Some(ms) = env_parse::<u64>("REACTOR_FUSE_INTERVAL_MS") {
            c.fusion_interval = Duration::from_millis(ms.max(100));
        }
        if let Some(n) = env_parse::<f64>("REACTOR_FUSE_COACCESS_MIN").filter(|n| n.is_finite() && *n > 0.0) {
            c.coaccess_min = n;
        }
        if let Some(ms) = env_parse::<u64>("REACTOR_GROUP_COMMIT_MS") {
            c.group_commit_window = Duration::from_millis(ms.min(100));
        }
        if let Some(ms) = env_parse::<u64>("REACTOR_ACCESS_HALFLIFE_MS") {
            c.access_half_life = Duration::from_millis(ms);
        }
        if let Some(n) = env_parse::<usize>("REACTOR_PACK_THRESHOLD") {
            c.pack_threshold = n.min(OBJECT_MAX_PLAIN);
        }
        if let Some(n) = env_parse::<u64>("REACTOR_PACK_MAX_BYTES").filter(|n| *n > 0) {
            c.pack_max_bytes = n.max(1 << 20);
        }
        if let Some(n) = env_parse::<u64>("REACTOR_INGEST_INFLIGHT_BYTES").filter(|n| *n > 0) {
            c.ingest_inflight_bytes = n.max(CDC_MAX as u64);
        }
        c
    }
}

// ---------------------------------------------------------------------------------------------
// Public data types
// ---------------------------------------------------------------------------------------------

pub mod hex_id {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(id: &super::Id, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&hex::encode(id))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<super::Id, D::Error> {
        let s = String::deserialize(d)?;
        super::parse_id(&s).ok_or_else(|| serde::de::Error::custom("expected 64 hex characters"))
    }
}

/// `{ id, len }` entry of a manifest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkEntry {
    #[serde(with = "hex_id")]
    pub id: Id,
    pub len: u32,
}

/// Spec manifest: `{ file_id, size, chunks: [{ id, len }], created_ms }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(with = "hex_id")]
    pub file_id: Id,
    pub size: u64,
    pub chunks: Vec<ChunkEntry>,
    pub created_ms: u64,
}

/// A manifest chunk plus where this node currently stores it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRef {
    #[serde(with = "hex_id")]
    pub id: Id,
    pub len: u32,
    /// Byte offset of the chunk inside the file.
    pub file_offset: u64,
    #[serde(with = "hex_id")]
    pub object_id: Id,
    /// Byte offset of the chunk inside the object's plaintext.
    pub object_offset: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FileMeta {
    #[serde(with = "hex_id")]
    pub file_id: Id,
    pub size: u64,
    pub chunks: u64,
    pub created_ms: u64,
    /// Written here by a client (vs. a replica imported from a peer).
    pub origin: bool,
    pub class: &'static str,
    pub pins: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ObjectMeta {
    #[serde(with = "hex_id")]
    pub object_id: Id,
    pub stored_len: u64,
    pub plain_len: u64,
    pub refcount: u64,
    pub created_ms: u64,
    pub class: &'static str,
    pub quarantined: bool,
    pub members: Vec<ChunkEntry>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Capacity {
    pub max_bytes: Option<u64>,
    /// Physical bytes of live objects (counted against `max_bytes`).
    pub live_bytes: u64,
    /// Physical bytes of all objects on disk, including those awaiting GC.
    pub physical_bytes: u64,
    pub inflight_bytes: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum FileEventKind {
    Added,
    Removed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct FileEvent {
    pub version: u64,
    pub kind: FileEventKind,
    #[serde(with = "hex_id")]
    pub file_id: Id,
}

/// Result of [`Store::verify_index`].
#[derive(Clone, Debug, Default, Serialize)]
pub struct ConsistencyReport {
    pub files: u64,
    pub chunks: u64,
    pub objects: u64,
    pub problems: Vec<String>,
}

impl ConsistencyReport {
    pub fn ok(&self) -> bool {
        self.problems.is_empty()
    }
}

pub type FailHook = Arc<dyn Fn(&str) -> bool + Send + Sync>;
pub type QuarantineHook = Arc<dyn Fn(Id) + Send + Sync>;
/// Called after every successful local [`Store::read_range`] with `(file_id, bytes read)`;
/// data gravity uses it to record demand.
pub type ReadHook = Arc<dyn Fn(&Id, u64) + Send + Sync>;

#[derive(Default)]
struct RuntimeStats {
    puts: AtomicU64,
    put_bytes: AtomicU64,
    reads: AtomicU64,
    read_bytes: AtomicU64,
    reads_saved_pending: AtomicU64,
    full_rejections: AtomicU64,
    evictions: AtomicU64,
    startup_orphans: AtomicU64,
    startup_temps: AtomicU64,
    fusion_candidates: AtomicU64,
    fusion_rejected: AtomicU64,
    fusion_last_ms: AtomicU64,
    /// Highest per-upload in-flight compression bytes seen (see `ingest_inflight_bytes`).
    ingest_inflight_peak: AtomicU64,
    /// Chunks compressed on the shared pool (vs. inline).
    pool_chunks: AtomicU64,
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

pub struct Store {
    pub cfg: StoreConfig,
    pub engine: Arc<Engine>,
    db: Database,
    objects_dir: PathBuf,
    quarantine_dir: PathBuf,
    reservations: Mutex<HashMap<Id, u32>>,
    inflight_bytes: AtomicU64,
    tmp_counter: AtomicU64,
    access: fusion::AccessTracker,
    policy: RwLock<Arc<dyn EvictionPolicy>>,
    quarantine_hook: RwLock<Option<QuarantineHook>>,
    fail_hook: RwLock<Option<FailHook>>,
    fail_armed: AtomicBool,
    /// Set when a fail point fired: the instance behaves as if the process died (no cleanup).
    crashed: AtomicBool,
    scrub: Mutex<scrub::ScrubState>,
    fusion_lock: Mutex<()>,
    evict_lock: Mutex<()>,
    /// Serializes "check existing file / rename into place" per object id (striped by the first
    /// id byte so concurrent writers of different objects install in parallel).
    place_locks: Vec<Mutex<()>>,
    group: group::GroupCommit,
    packs: pack::Packs,
    read_hook: RwLock<Option<ReadHook>>,
    stats: RuntimeStats,
}

impl Store {
    /// Opens (or creates) the store, creates the index tables (an index from before pack files
    /// simply gains an empty `packs` table; its objects stay file-based), sweeps orphan / temp
    /// object files and truncates every pack to its committed end.
    pub fn open(cfg: StoreConfig, engine: Arc<Engine>) -> Result<Store> {
        let objects_dir = cfg.dir.join("objects");
        let quarantine_dir = cfg.dir.join("quarantine");
        std::fs::create_dir_all(&objects_dir)?;
        std::fs::create_dir_all(&quarantine_dir)?;
        std::fs::create_dir_all(cfg.dir.join("packs"))?;
        let db = Database::create(cfg.dir.join("index.redb"))?;
        {
            let tx = db.begin_write()?;
            index::init(&tx)?;
            tx.commit()?;
        }
        let store = Store {
            access: fusion::AccessTracker::default(),
            cfg,
            engine,
            db,
            objects_dir,
            quarantine_dir,
            reservations: Mutex::new(HashMap::new()),
            inflight_bytes: AtomicU64::new(0),
            tmp_counter: AtomicU64::new(0),
            policy: RwLock::new(Arc::new(PinnedOriginPolicy)),
            quarantine_hook: RwLock::new(None),
            fail_hook: RwLock::new(None),
            fail_armed: AtomicBool::new(false),
            crashed: AtomicBool::new(false),
            scrub: Mutex::new(scrub::ScrubState::default()),
            fusion_lock: Mutex::new(()),
            evict_lock: Mutex::new(()),
            place_locks: (0..64).map(|_| Mutex::new(())).collect(),
            group: group::GroupCommit::default(),
            packs: pack::Packs::default(),
            read_hook: RwLock::new(None),
            stats: RuntimeStats::default(),
        };
        store.sweep()?;
        store.recover_packs()?;
        Ok(store)
    }

    pub fn dir(&self) -> &Path {
        &self.cfg.dir
    }

    /// Removes temp files and object files that have no index row (left by a crash between
    /// "write object" and "commit index"), or whose object now lives in a pack (stale copy left by
    /// a crash after a repair moved it).
    fn sweep(&self) -> Result<()> {
        let tx = self.db.begin_read()?;
        let objects = tx.open_table(index::OBJECTS)?;
        let (mut orphans, mut temps) = (0u64, 0u64);
        for shard in std::fs::read_dir(&self.objects_dir)? {
            let shard = shard?.path();
            if !shard.is_dir() {
                continue;
            }
            for entry in std::fs::read_dir(&shard)? {
                let p = entry?.path();
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                if name.ends_with(".tmp") {
                    if std::fs::remove_file(&p).is_ok() {
                        temps += 1;
                    }
                    continue;
                }
                let Some(id) = name.strip_suffix(".obj").and_then(parse_id) else { continue };
                let stale = match objects.get(&id)? {
                    None => true,
                    Some(g) => ObjectRec::decode(g.value())?.pack.is_some(),
                };
                if stale && std::fs::remove_file(&p).is_ok() {
                    orphans += 1;
                }
            }
        }
        self.stats.startup_orphans.store(orphans, Ordering::Relaxed);
        self.stats.startup_temps.store(temps, Ordering::Relaxed);
        if orphans + temps > 0 {
            eprintln!("[store] startup sweep removed {} orphan objects and {} temp files", orphans, temps);
        }
        Ok(())
    }

    // ---- hooks -------------------------------------------------------------------------------

    /// Replaces the eviction policy (data gravity installs its own).
    pub fn set_eviction_policy(&self, p: Arc<dyn EvictionPolicy>) {
        *self.policy.write().unwrap_or_else(|e| e.into_inner()) = p;
    }

    pub fn eviction_policy(&self) -> Arc<dyn EvictionPolicy> {
        self.policy.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// Called (from the scrub / read thread) with every newly quarantined object id, so data
    /// gravity can re-fetch it from a peer and call [`Store::repair_object_raw`] /
    /// [`Store::repair_object_plain`].
    pub fn set_quarantine_hook(&self, h: Option<QuarantineHook>) {
        *self.quarantine_hook.write().unwrap_or_else(|e| e.into_inner()) = h;
    }

    /// Installs (or clears) the read hook (see [`ReadHook`]).
    pub fn set_read_hook(&self, h: Option<ReadHook>) {
        *self.read_hook.write().unwrap_or_else(|e| e.into_inner()) = h;
    }

    pub(crate) fn notify_read(&self, file_id: &Id, bytes: u64) {
        let hook = self.read_hook.read().unwrap_or_else(|e| e.into_inner()).clone();
        if let Some(h) = hook {
            h(file_id, bytes);
        }
    }

    /// Test hook: called at named fail points; returning true simulates a crash there.
    #[doc(hidden)]
    pub fn set_fail_hook(&self, h: Option<FailHook>) {
        self.fail_armed.store(h.is_some(), Ordering::SeqCst);
        *self.fail_hook.write().unwrap_or_else(|e| e.into_inner()) = h;
    }

    fn fail(&self, point: &'static str) -> Result<()> {
        if self.fail_armed.load(Ordering::Relaxed) {
            let hook = self.fail_hook.read().unwrap_or_else(|e| e.into_inner()).clone();
            if hook.is_some_and(|h| h(point)) {
                self.crashed.store(true, Ordering::SeqCst);
                return Err(StoreError::Injected(point));
            }
        }
        Ok(())
    }

    fn is_crashed(&self) -> bool {
        self.crashed.load(Ordering::SeqCst)
    }

    // ---- reservations ------------------------------------------------------------------------

    fn reserve(&self, ids: &[Id]) {
        let mut m = lock(&self.reservations);
        for id in ids {
            *m.entry(*id).or_insert(0) += 1;
        }
    }

    /// Drops reservations; files in `created` whose reservation reached zero and that have no
    /// index row are deleted (an aborted write must not leave orphans behind).
    fn unreserve(&self, ids: &[Id], created: &[Id]) {
        if self.is_crashed() {
            return;
        }
        let mut m = lock(&self.reservations);
        for id in ids {
            if let Some(c) = m.get_mut(id) {
                *c -= 1;
                if *c == 0 {
                    m.remove(id);
                }
            }
        }
        let free: Vec<&Id> = created.iter().filter(|id| !m.contains_key(*id)).collect();
        if free.is_empty() {
            return;
        }
        let Ok(tx) = self.db.begin_read() else { return };
        let Ok(objects) = tx.open_table(index::OBJECTS) else { return };
        for id in free {
            if matches!(objects.get(id), Ok(None)) {
                let _ = std::fs::remove_file(self.object_path(id));
            }
        }
    }

    fn is_reserved_locked(m: &HashMap<Id, u32>, id: &Id, rec: &ObjectRec) -> bool {
        m.contains_key(id) || rec.members.iter().any(|c| m.contains_key(c))
    }

    // ---- object files ------------------------------------------------------------------------

    pub(crate) fn object_path(&self, id: &Id) -> PathBuf {
        let h = id_hex(id);
        self.objects_dir.join(&h[..2]).join(format!("{}.obj", h))
    }

    /// temp file → write → fsync → rename (→ fsync dir on unix).
    fn write_file_atomic(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        let dir = path.parent().unwrap_or_else(|| Path::new("."));
        std::fs::create_dir_all(dir)?;
        let n = self.tmp_counter.fetch_add(1, Ordering::Relaxed);
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let tmp = dir.join(format!(".{}.{}.{}.tmp", name, std::process::id(), n));
        let res = (|| -> std::io::Result<()> {
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
            drop(f);
            std::fs::rename(&tmp, path)?;
            #[cfg(unix)]
            if let Ok(d) = std::fs::File::open(dir) {
                let _ = d.sync_all();
            }
            Ok(())
        })();
        if res.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        res.map_err(StoreError::Io)
    }

    /// Decodes a blob-v2 object (CRC-checked by the codec).
    pub fn decode_blob(&self, blob: &[u8]) -> Result<Vec<u8>> {
        decode_blob_with(&self.engine, blob)
    }

    /// Decodes a raw stored object (e.g. fetched from a peer) and checks that its plaintext hashes
    /// to `object_id`. Use for remote reads that are not stored locally.
    pub fn decode_object(&self, object_id: &Id, raw: &[u8]) -> Result<Vec<u8>> {
        let plain = self.decode_blob(raw)?;
        if sha256(&plain) != *object_id {
            return Err(StoreError::Corrupt(format!("object {} plaintext hash mismatch", id_hex(object_id))));
        }
        Ok(plain)
    }

    /// Stored bytes of an object from wherever the index says it lives: its pack record (checked:
    /// magic, id, length, CRC) or its file. Objects without a row (staged, not yet committed) are
    /// read from their file path. When a read fails but the location changed meanwhile
    /// (compaction or repair moved the object), the location is re-resolved and the read retried.
    /// Inner `Err` = the stored bytes are unreadable or fail the record check.
    pub(crate) fn read_stored(&self, id: &Id) -> Result<std::result::Result<Vec<u8>, String>> {
        let mut last: Option<(Option<PackLoc>, String)> = None;
        for _ in 0..4 {
            let rec = self.object_rec(id)?;
            let loc = rec.as_ref().and_then(|r| r.pack.map(|p| (p, r.stored_len)));
            if last.as_ref().is_some_and(|(prev, _)| *prev == loc.map(|l| l.0)) {
                break;
            }
            let r = match loc {
                Some((l, len)) => self.read_packed(id, l, len),
                None => std::fs::read(self.object_path(id)).map_err(|e| format!("object file unreadable: {}", e)),
            };
            match r {
                Ok(b) => return Ok(Ok(b)),
                Err(e) => last = Some((loc.map(|l| l.0), e)),
            }
        }
        Ok(Err(last.map(|l| l.1).unwrap_or_else(|| "object unreadable".into())))
    }

    /// Reads and decodes a local object (pack record or file); failure quarantines the object.
    fn read_object_plain(&self, id: &Id) -> Result<Vec<u8>> {
        let blob = match self.read_stored(id)? {
            Ok(b) => b,
            Err(reason) => {
                self.quarantine(id, &reason);
                return Err(StoreError::Corrupt(reason));
            }
        };
        match self.decode_blob(&blob) {
            Ok(p) => Ok(p),
            Err(StoreError::UnknownDict(d)) => Err(StoreError::UnknownDict(d)),
            Err(e) => {
                let reason = format!("object decode failed: {}", e);
                self.quarantine(id, &reason);
                Err(StoreError::Corrupt(reason))
            }
        }
    }

    /// Encoder for a content class: the class champion recipe (raw for non-evolvable classes).
    fn encoder(&self, class: &'static str) -> ObjEncoder {
        if !classify::is_evolvable(class) {
            return ObjEncoder { class, recipe: Recipe::new(Codec::Raw, 0), dict: None };
        }
        let mut recipe = self.engine.champion_recipe(class);
        let mut dict = None;
        if let Some(id) = recipe.dict_id() {
            dict = self.engine.dicts.get(&id);
            if dict.is_none() {
                recipe = Recipe::baseline();
            }
        }
        ObjEncoder { class, recipe, dict }
    }

    /// Encodes with the encoder's recipe, verifies the round-trip; falls back to raw v2 when the
    /// recipe fails, does not verify, or is not smaller.
    fn encode_verified(&self, enc: &ObjEncoder, data: &[u8]) -> Result<Vec<u8>> {
        encode_verified_with(&self.engine, enc, data)
    }

    // ---- simple lookups ----------------------------------------------------------------------

    fn read_tx(&self) -> Result<redb::ReadTransaction> {
        Ok(self.db.begin_read()?)
    }

    fn meta_snapshot(&self) -> Result<HashMap<String, u64>> {
        let tx = self.read_tx()?;
        let t = tx.open_table(index::META)?;
        let mut out = HashMap::new();
        for r in t.range::<&str>(..)? {
            let (k, v) = r?;
            out.insert(k.value().to_string(), v.value());
        }
        Ok(out)
    }

    fn meta_value(&self, key: &str) -> Result<u64> {
        let tx = self.read_tx()?;
        let t = tx.open_table(index::META)?;
        Ok(t.get(key)?.map(|g| g.value()).unwrap_or(0))
    }

    pub fn file_meta(&self, file_id: &Id) -> Result<Option<FileMeta>> {
        let tx = self.read_tx()?;
        let m = tx.open_table(index::MANIFESTS)?;
        let Some(rec) = m.get(file_id)?.map(|g| index::FileRec::decode(g.value())).transpose()? else {
            return Ok(None);
        };
        let pins = tx.open_table(index::PINS)?.get(file_id)?.map(|g| g.value()).unwrap_or(0);
        Ok(Some(FileMeta {
            file_id: *file_id,
            size: rec.size,
            chunks: rec.chunk_count,
            created_ms: rec.created_ms,
            origin: rec.origin,
            class: class_name(rec.class),
            pins,
        }))
    }

    pub fn contains_file(&self, file_id: &Id) -> Result<bool> {
        Ok(self.file_meta(file_id)?.is_some())
    }

    /// Files in id order after `after` (exclusive), at most `limit`.
    pub fn list_files(&self, after: Option<&Id>, limit: usize) -> Result<Vec<FileMeta>> {
        let tx = self.read_tx()?;
        let m = tx.open_table(index::MANIFESTS)?;
        let pins = tx.open_table(index::PINS)?;
        let mut out = Vec::new();
        let iter = match after {
            Some(a) => m.range::<&[u8; 32]>((std::ops::Bound::Excluded(a), std::ops::Bound::Unbounded))?,
            None => m.range::<&[u8; 32]>(..)?,
        };
        for r in iter {
            if out.len() >= limit {
                break;
            }
            let (k, v) = r?;
            let id = *k.value();
            let rec = index::FileRec::decode(v.value())?;
            out.push(FileMeta {
                file_id: id,
                size: rec.size,
                chunks: rec.chunk_count,
                created_ms: rec.created_ms,
                origin: rec.origin,
                class: class_name(rec.class),
                pins: pins.get(&id)?.map(|g| g.value()).unwrap_or(0),
            });
        }
        Ok(out)
    }

    /// Manifest chunk list read in one snapshot.
    pub fn get_manifest(&self, file_id: &Id) -> Result<Option<Manifest>> {
        Ok(self.chunk_refs(file_id)?.map(|(meta, refs)| Manifest {
            file_id: *file_id,
            size: meta.size,
            chunks: refs.iter().map(|r| ChunkEntry { id: r.id, len: r.len }).collect(),
            created_ms: meta.created_ms,
        }))
    }

    /// Manifest plus the current location of every chunk (what a peer needs to fetch objects).
    pub fn chunk_refs(&self, file_id: &Id) -> Result<Option<(FileMeta, Vec<ChunkRef>)>> {
        let tx = self.read_tx()?;
        let m = tx.open_table(index::MANIFESTS)?;
        let Some(rec) = m.get(file_id)?.map(|g| index::FileRec::decode(g.value())).transpose()? else {
            return Ok(None);
        };
        let pins = tx.open_table(index::PINS)?.get(file_id)?.map(|g| g.value()).unwrap_or(0);
        let mc = tx.open_table(index::MANIFEST_CHUNKS)?;
        let locs = tx.open_table(index::CHUNK_LOC)?;
        let mut out = Vec::with_capacity(rec.chunk_count as usize);
        let lo = index::mchunk_key(file_id, 0);
        let hi = index::mchunk_key(file_id, u64::MAX);
        for r in mc.range::<&[u8; 40]>(&lo..=&hi)? {
            let (k, v) = r?;
            let (id, len) = index::mchunk_val_decode(v.value());
            let loc = locs
                .get(&id)?
                .map(|g| index::ChunkLoc::decode(g.value()))
                .transpose()?
                .ok_or_else(|| StoreError::Corrupt(format!("chunk {} has no location", id_hex(&id))))?;
            out.push(ChunkRef { id, len, file_offset: index::mchunk_key_offset(k.value()), object_id: loc.object, object_offset: loc.offset });
        }
        let meta = FileMeta {
            file_id: *file_id,
            size: rec.size,
            chunks: rec.chunk_count,
            created_ms: rec.created_ms,
            origin: rec.origin,
            class: class_name(rec.class),
            pins,
        };
        Ok(Some((meta, out)))
    }

    pub fn object_meta(&self, object_id: &Id) -> Result<Option<ObjectMeta>> {
        let tx = self.read_tx()?;
        let objects = tx.open_table(index::OBJECTS)?;
        let Some(rec) = objects.get(object_id)?.map(|g| ObjectRec::decode(g.value())).transpose()? else {
            return Ok(None);
        };
        let members = rec.members.iter().zip(&rec.lens).map(|(id, len)| ChunkEntry { id: *id, len: *len }).collect();
        Ok(Some(ObjectMeta {
            object_id: *object_id,
            stored_len: rec.stored_len,
            plain_len: rec.plain_len,
            refcount: rec.refcount,
            created_ms: rec.created_ms,
            class: class_name(rec.class),
            quarantined: rec.quarantined(),
            members,
        }))
    }

    pub fn has_object(&self, object_id: &Id) -> Result<bool> {
        let tx = self.read_tx()?;
        Ok(tx.open_table(index::OBJECTS)?.get(object_id)?.is_some())
    }

    /// The raw stored object bytes (blob v2), verified (decode + plaintext hash) before they are
    /// returned so corruption never propagates to peers. Corrupt objects are quarantined.
    pub fn get_object_raw(&self, object_id: &Id) -> Result<Option<Vec<u8>>> {
        let mut res = Reservation::new(self);
        res.add(*object_id);
        let Some(rec) = self.object_rec(object_id)? else { return Ok(None) };
        if rec.quarantined() {
            return Err(StoreError::Corrupt(format!("object {} is quarantined", id_hex(object_id))));
        }
        let raw = match self.read_stored(object_id)? {
            Ok(r) => r,
            Err(reason) => {
                self.quarantine(object_id, &reason);
                return Err(StoreError::Corrupt(reason));
            }
        };
        match self.decode_object(object_id, &raw) {
            Ok(_) => Ok(Some(raw)),
            Err(StoreError::UnknownDict(d)) => Err(StoreError::UnknownDict(d)),
            Err(e) => {
                self.quarantine(object_id, &e.to_string());
                Err(e)
            }
        }
    }

    fn object_rec(&self, id: &Id) -> Result<Option<ObjectRec>> {
        let tx = self.read_tx()?;
        tx.open_table(index::OBJECTS)?.get(id)?.map(|g| ObjectRec::decode(g.value())).transpose()
    }

    /// Inventory delta log: events with version > `since` (at most `limit`) and the current version.
    pub fn file_events_since(&self, since: u64, limit: usize) -> Result<(Vec<FileEvent>, u64)> {
        let tx = self.read_tx()?;
        let log = tx.open_table(index::FILE_LOG)?;
        let mut out = Vec::new();
        for r in log.range(since.saturating_add(1)..)? {
            if out.len() >= limit {
                break;
            }
            let (k, v) = r?;
            let b = v.value();
            if b.len() != 33 {
                continue;
            }
            let kind = if b[0] == index::LOG_ADD { FileEventKind::Added } else { FileEventKind::Removed };
            let mut id = [0u8; 32];
            id.copy_from_slice(&b[1..]);
            out.push(FileEvent { version: k.value(), kind, file_id: id });
        }
        let version = tx.open_table(index::META)?.get(meta::INVENTORY_VERSION)?.map(|g| g.value()).unwrap_or(0);
        Ok((out, version))
    }

    /// Oldest inventory version still in the delta log (older `since` values need a full listing).
    pub fn file_log_floor(&self) -> Result<u64> {
        let tx = self.read_tx()?;
        let log = tx.open_table(index::FILE_LOG)?;
        let floor = log.first()?.map(|(k, _)| k.value()).unwrap_or(0);
        Ok(floor)
    }

    /// Tombstones with `deleted_ms >= since_ms`.
    pub fn tombstones(&self, since_ms: u64) -> Result<Vec<(Id, u64)>> {
        let tx = self.read_tx()?;
        let t = tx.open_table(index::TOMBSTONES)?;
        let mut out = Vec::new();
        for r in t.range::<&[u8; 32]>(..)? {
            let (k, v) = r?;
            if v.value() >= since_ms {
                out.push((*k.value(), v.value()));
            }
        }
        Ok(out)
    }

    pub fn tombstone(&self, file_id: &Id) -> Result<Option<u64>> {
        let tx = self.read_tx()?;
        Ok(tx.open_table(index::TOMBSTONES)?.get(file_id)?.map(|g| g.value()))
    }

    pub fn capacity(&self) -> Result<Capacity> {
        let m = self.meta_snapshot()?;
        Ok(Capacity {
            max_bytes: self.cfg.max_bytes,
            live_bytes: m.get(meta::LIVE).copied().unwrap_or(0),
            physical_bytes: m.get(meta::PHYSICAL).copied().unwrap_or(0),
            inflight_bytes: self.inflight_bytes.load(Ordering::Relaxed),
        })
    }

    // ---- stats -------------------------------------------------------------------------------

    pub fn stats(&self) -> Result<serde_json::Value> {
        let m = self.meta_snapshot()?;
        let g = |k: &str| m.get(k).copied().unwrap_or(0);
        let (gc_objects, quarantined, tombstones, chunks, access_rows) = {
            let tx = self.read_tx()?;
            (
                tx.open_table(index::GC_QUEUE)?.len()?,
                tx.open_table(index::QUARANTINE)?.len()?,
                tx.open_table(index::TOMBSTONES)?.len()?,
                tx.open_table(index::CHUNK_LOC)?.len()?,
                tx.open_table(index::ACCESS)?.len()?,
            )
        };
        let (logical, unique, physical, live) = (g(meta::LOGICAL), g(meta::UNIQUE), g(meta::PHYSICAL), g(meta::LIVE));
        let ratio = |a: u64, b: u64| if b == 0 { 1.0 } else { a as f64 / b as f64 };
        let s = &self.stats;
        let ld = |a: &AtomicU64| a.load(Ordering::Relaxed);
        Ok(serde_json::json!({
            "files": g(meta::FILES),
            "logical_bytes": logical,
            "unique_bytes": unique,
            "physical_bytes": physical,
            "live_physical_bytes": live,
            "max_bytes": self.cfg.max_bytes,
            "dedup_ratio": ratio(logical, unique),
            "compression_ratio": ratio(unique, live),
            "total_ratio": ratio(logical, live),
            "objects": g(meta::OBJECTS),
            "super_chunks": g(meta::SUPER),
            "chunks": chunks,
            "tombstones": tombstones,
            "inventory_version": g(meta::INVENTORY_VERSION),
            "inflight_bytes": ld(&self.inflight_bytes),
            "puts": ld(&s.puts),
            "put_bytes": ld(&s.put_bytes),
            "reads": ld(&s.reads),
            "read_bytes": ld(&s.read_bytes),
            "full_rejections": ld(&s.full_rejections),
            "evictions": ld(&s.evictions),
            "group_commit": {
                "batches": ld(&self.group.batches),
                "jobs": ld(&self.group.jobs),
                "max_batch": ld(&self.group.max_batch),
                "window_ms": self.cfg.group_commit_window.as_secs_f64() * 1000.0,
            },
            "gc": {
                "queue_objects": gc_objects,
                "queue_bytes": physical.saturating_sub(live),
                "grace_ms": self.cfg.gc_grace.as_millis() as u64,
                "collected_objects": g(meta::GC_OBJECTS),
                "collected_bytes": g(meta::GC_BYTES),
                "startup_orphans_removed": ld(&s.startup_orphans),
                "startup_temp_files_removed": ld(&s.startup_temps),
            },
            "fusion": {
                "enabled": self.cfg.fusion,
                "fusions": g(meta::FUSIONS),
                "unfusions": g(meta::UNFUSIONS),
                "bytes_saved": g(meta::FUSION_SAVED),
                "reads_saved": g(meta::READS_SAVED) + ld(&s.reads_saved_pending),
                "candidates_evaluated": ld(&s.fusion_candidates),
                "rejected": ld(&s.fusion_rejected),
                "last_run_ms": ld(&s.fusion_last_ms),
                "access_rows": access_rows,
                "coaccess_min": self.cfg.coaccess_min,
            },
            "ingest": {
                "compress_threads": self.cfg.compress_threads,
                "pool_threads": crate::workers::pool_threads(),
                "inflight_cap_bytes": self.cfg.ingest_inflight_bytes,
                "inflight_peak_bytes": ld(&s.ingest_inflight_peak),
                "pool_chunks": ld(&s.pool_chunks),
            },
            "scrub": self.scrub_status(quarantined),
            "packs": self.packs_stats(&m)?,
        }))
    }

    // ---- background --------------------------------------------------------------------------

    /// Spawns the GC, access-flush, scrub and fusion loops.
    pub fn spawn_tasks(
        self: Arc<Self>,
        mut shutdown: tokio::sync::watch::Receiver<bool>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let tick = Duration::from_millis(250);
            let start = tokio::time::Instant::now();
            let (mut last_gc, mut last_flush, mut last_scrub, mut last_fuse) = (start, start, start, start);
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(tick) => {}
                    _ = shutdown.changed() => break,
                }
                if *shutdown.borrow() {
                    break;
                }
                let now = tokio::time::Instant::now();
                let mut jobs: Vec<&'static str> = Vec::new();
                if now - last_flush >= self.cfg.access_flush_interval {
                    last_flush = now;
                    jobs.push("flush");
                }
                if now - last_gc >= self.cfg.gc_interval {
                    last_gc = now;
                    jobs.push("gc");
                }
                if now - last_scrub >= self.cfg.scrub_interval {
                    last_scrub = now;
                    jobs.push("scrub");
                }
                if self.cfg.fusion && now - last_fuse >= self.cfg.fusion_interval {
                    last_fuse = now;
                    jobs.push("fusion");
                }
                for job in jobs {
                    let s = self.clone();
                    let r = tokio::task::spawn_blocking(move || -> Result<()> {
                        match job {
                            "flush" => s.flush_access(),
                            "gc" => s.gc().map(|_| ()),
                            "scrub" => s.scrub_step(s.cfg.scrub_bytes).map(|_| ()),
                            _ => s.run_fusion_pass().map(|_| ()),
                        }
                    })
                    .await;
                    match r {
                        Ok(Ok(())) => {}
                        Ok(Err(e)) => eprintln!("[store] {} failed: {}", job, e),
                        Err(e) => eprintln!("[store] {} task panicked: {}", job, e),
                    }
                }
            }
            let s = self.clone();
            let _ = tokio::task::spawn_blocking(move || s.flush_access()).await;
        })
    }

    // ---- fsck --------------------------------------------------------------------------------

    /// Full consistency check of the index against itself and the object files (an fsck).
    /// `deep` also decodes every object and verifies every member chunk hash.
    pub fn verify_index(&self, deep: bool) -> Result<ConsistencyReport> {
        let tx = self.read_tx()?;
        let mut rep = ConsistencyReport::default();
        let mut p = |s: String| rep_push(&mut rep.problems, s);
        let manifests = tx.open_table(index::MANIFESTS)?;
        let mc = tx.open_table(index::MANIFEST_CHUNKS)?;
        let locs = tx.open_table(index::CHUNK_LOC)?;
        let objects = tx.open_table(index::OBJECTS)?;
        let gcq = tx.open_table(index::GC_QUEUE)?;
        let meta_t = tx.open_table(index::META)?;
        let mg = |k: &str| -> Result<u64> { Ok(meta_t.get(k)?.map(|g| g.value()).unwrap_or(0)) };

        let mut occurrences: HashMap<Id, u64> = HashMap::new();
        let (mut files, mut logical) = (0u64, 0u64);
        for r in manifests.range::<&[u8; 32]>(..)? {
            let (k, v) = r?;
            let fid = *k.value();
            let rec = index::FileRec::decode(v.value())?;
            files += 1;
            logical += rec.size;
            let (mut n, mut expect_off) = (0u64, 0u64);
            for r in mc.range::<&[u8; 40]>(&index::mchunk_key(&fid, 0)..=&index::mchunk_key(&fid, u64::MAX))? {
                let (k, v) = r?;
                let off = index::mchunk_key_offset(k.value());
                let (cid, len) = index::mchunk_val_decode(v.value());
                if off != expect_off {
                    p(format!("file {}: chunk at {} expected {}", id_hex(&fid), off, expect_off));
                }
                expect_off = off + len as u64;
                n += 1;
                *occurrences.entry(cid).or_insert(0) += 1;
            }
            if n != rec.chunk_count || expect_off != rec.size {
                p(format!("file {}: {} chunks / {} bytes, header says {} / {}", id_hex(&fid), n, expect_off, rec.chunk_count, rec.size));
            }
        }
        // every manifest_chunks row belongs to a manifest
        let mut prev: Option<Id> = None;
        for r in mc.range::<&[u8; 40]>(..)? {
            let (k, _) = r?;
            let mut fid = [0u8; 32];
            fid.copy_from_slice(&k.value()[..32]);
            if prev != Some(fid) {
                if manifests.get(&fid)?.is_none() {
                    p(format!("manifest_chunks rows for unknown file {}", id_hex(&fid)));
                }
                prev = Some(fid);
            }
        }
        let mut obj_live: HashMap<Id, u64> = HashMap::new();
        let mut chunks = 0u64;
        for r in locs.range::<&[u8; 32]>(..)? {
            let (k, v) = r?;
            let cid = *k.value();
            let loc = index::ChunkLoc::decode(v.value())?;
            chunks += 1;
            let occ = occurrences.remove(&cid).unwrap_or(0);
            if loc.refs != occ {
                p(format!("chunk {}: refs {} but {} manifest occurrences", id_hex(&cid), loc.refs, occ));
            }
            match objects.get(&loc.object)?.map(|g| ObjectRec::decode(g.value())).transpose()? {
                None => p(format!("chunk {} points at missing object {}", id_hex(&cid), id_hex(&loc.object))),
                Some(o) => {
                    if loc.offset as u64 + loc.len as u64 > o.plain_len {
                        p(format!("chunk {} lies outside object {}", id_hex(&cid), id_hex(&loc.object)));
                    }
                    if o.member_span(&cid) != Some((loc.offset, loc.len)) {
                        p(format!("chunk {} not a member of object {} at its offset", id_hex(&cid), id_hex(&loc.object)));
                    }
                }
            }
            if loc.refs > 0 {
                *obj_live.entry(loc.object).or_insert(0) += 1;
            }
        }
        for (cid, n) in occurrences {
            p(format!("chunk {} referenced {} times but not indexed", id_hex(&cid), n));
        }
        let pack_rows: HashMap<u64, index::PackRec> = self.pack_rows()?.into_iter().collect();
        let mut pack_live: HashMap<u64, (u64, u64)> = HashMap::new();
        let (mut objs, mut supers, mut physical, mut live, mut unique) = (0u64, 0u64, 0u64, 0u64, 0u64);
        for r in objects.range::<&[u8; 32]>(..)? {
            let (k, v) = r?;
            let oid = *k.value();
            let o = ObjectRec::decode(v.value())?;
            objs += 1;
            physical += o.stored_len;
            if o.is_super() {
                supers += 1;
            }
            let lv = obj_live.remove(&oid).unwrap_or(0);
            if o.refcount != lv {
                p(format!("object {}: refcount {} but {} live chunks", id_hex(&oid), o.refcount, lv));
            }
            if o.refcount > 0 {
                live += o.stored_len;
                unique += o.plain_len;
            }
            let queued = gcq.get(&oid)?.is_some();
            if queued != (o.refcount == 0) {
                p(format!("object {}: refcount {} but gc_queued={}", id_hex(&oid), o.refcount, queued));
            }
            if o.quarantined() && o.pack.is_some() {
                p(format!("object {}: quarantined but still linked into pack", id_hex(&oid)));
            }
            if !o.quarantined() {
                match o.pack {
                    Some(l) => {
                        let e = pack_live.entry(l.pack).or_insert((0, 0));
                        e.0 += pack::record_size(o.stored_len);
                        e.1 += 1;
                        match pack_rows.get(&l.pack) {
                            Some(r) if l.offset >= pack::PACK_HEADER && l.offset + pack::record_size(o.stored_len) <= r.end => {}
                            Some(r) => p(format!("object {}: record at pack {} @ {} beyond committed end {}", id_hex(&oid), l.pack, l.offset, r.end)),
                            None => p(format!("object {}: pack {} has no row", id_hex(&oid), l.pack)),
                        }
                        if !deep {
                            if let Err(e) = self.read_packed(&oid, l, o.stored_len) {
                                p(format!("object {}: {}", id_hex(&oid), e));
                            }
                        }
                    }
                    None => match std::fs::metadata(self.object_path(&oid)) {
                        Ok(md) if md.len() == o.stored_len => {}
                        Ok(md) => p(format!("object {}: file has {} bytes, index {}", id_hex(&oid), md.len(), o.stored_len)),
                        Err(_) => p(format!("object {}: file missing", id_hex(&oid))),
                    },
                }
                if deep {
                    if let Err(e) = self.verify_object_data(&oid, &o) {
                        p(format!("object {}: {}", id_hex(&oid), e));
                    }
                }
            }
        }
        for r in gcq.range::<&[u8; 32]>(..)? {
            let (k, _) = r?;
            if objects.get(k.value())?.is_none() {
                p(format!("gc_queue entry for unknown object {}", id_hex(k.value())));
            }
        }
        for (k, want) in [
            (meta::FILES, files),
            (meta::LOGICAL, logical),
            (meta::OBJECTS, objs),
            (meta::SUPER, supers),
            (meta::PHYSICAL, physical),
            (meta::LIVE, live),
            (meta::UNIQUE, unique),
        ] {
            let have = mg(k)?;
            if have != want {
                p(format!("counter {} = {}, recomputed {}", k, have, want));
            }
        }
        // orphan files
        for shard in std::fs::read_dir(&self.objects_dir)? {
            let shard = shard?.path();
            if !shard.is_dir() {
                continue;
            }
            for e in std::fs::read_dir(&shard)? {
                let path = e?.path();
                let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                match name.strip_suffix(".obj").and_then(parse_id) {
                    Some(id) => match objects.get(&id)?.map(|g| ObjectRec::decode(g.value())).transpose()? {
                        Some(o) if o.pack.is_none() => {}
                        Some(_) => p(format!("stale file {} for a packed object", name)),
                        None => p(format!("orphan file {}", name)),
                    },
                    None => p(format!("orphan file {}", name)),
                }
            }
        }
        self.verify_packs(&pack_live, &mut p)?;
        rep.files = files;
        rep.chunks = chunks;
        rep.objects = objs;
        Ok(rep)
    }

    /// Verifies an object's stored bytes against `rec`; when that fails but the object was moved
    /// meanwhile (compaction / repair), verifies the current location instead.
    fn verify_object_data(&self, id: &Id, rec: &ObjectRec) -> std::result::Result<(), String> {
        match self.verify_object_at(id, rec) {
            Ok(()) => Ok(()),
            Err(e) => match self.object_rec(id) {
                Ok(Some(cur)) if cur.pack != rec.pack || cur.stored_len != rec.stored_len => self.verify_object_at(id, &cur),
                _ => Err(e),
            },
        }
    }

    /// Decodes an object, checks its plaintext hash, length and every live member chunk.
    fn verify_object_at(&self, id: &Id, rec: &ObjectRec) -> std::result::Result<(), String> {
        let raw = match rec.pack {
            Some(l) => self.read_packed(id, l, rec.stored_len)?,
            None => std::fs::read(self.object_path(id)).map_err(|e| format!("unreadable: {}", e))?,
        };
        if raw.len() as u64 != rec.stored_len {
            return Err(format!("stored length {} != index {}", raw.len(), rec.stored_len));
        }
        let plain = self.decode_object(id, &raw).map_err(|e| e.to_string())?;
        if plain.len() as u64 != rec.plain_len {
            return Err(format!("plain length {} != index {}", plain.len(), rec.plain_len));
        }
        Ok(())
    }
}

/// [`Store::decode_blob`] without the store (usable from pool workers).
fn decode_blob_with(engine: &Engine, blob: &[u8]) -> Result<Vec<u8>> {
    if blob.first() != Some(&codec::FLAG_RECIPE) {
        return Err(StoreError::Corrupt("object is not a blob-v2".into()));
    }
    Ok(codec::decode_v2(blob, OBJECT_MAX_PLAIN, &|id: &DictId| engine.dicts.get(id))?)
}

/// Encodes with the encoder's recipe (single-threaded codec), verifies the round-trip; falls back
/// to raw v2 when the recipe fails, does not verify, or is not smaller. Pure function of
/// (`enc`, `data`), so it can run on any thread.
pub(crate) fn encode_verified_with(engine: &Engine, enc: &ObjEncoder, data: &[u8]) -> Result<Vec<u8>> {
    if enc.recipe.codec != Codec::Raw {
        if let Ok(b) = enc.recipe.encode(data, enc.dict.as_deref().map(|d| d.as_slice())) {
            if b.len() < data.len() + HEADER_LEN && decode_blob_with(engine, &b).is_ok_and(|p| p == data) {
                return Ok(b);
            }
        }
    }
    let raw = Recipe::new(Codec::Raw, 0).encode(data, None).map_err(StoreError::Invalid)?;
    if decode_blob_with(engine, &raw)? != data {
        return Err(StoreError::Corrupt("raw round-trip failed".into()));
    }
    Ok(raw)
}

fn rep_push(v: &mut Vec<String>, s: String) {
    if v.len() < 200 {
        v.push(s);
    }
}

pub(crate) struct ObjEncoder {
    pub class: &'static str,
    pub recipe: Recipe,
    pub dict: Option<Arc<Vec<u8>>>,
}

/// RAII reservation of ids (see module docs). `created` lists object files this holder may have
/// written; on release they are deleted unless indexed or still reserved by someone else.
pub(crate) struct Reservation<'a> {
    store: &'a Store,
    ids: Vec<Id>,
    created: Vec<Id>,
}

impl<'a> Reservation<'a> {
    pub fn new(store: &'a Store) -> Reservation<'a> {
        Reservation { store, ids: Vec::new(), created: Vec::new() }
    }
    pub fn add(&mut self, id: Id) {
        self.store.reserve(&[id]);
        self.ids.push(id);
    }
    pub fn add_all(&mut self, ids: &[Id]) {
        self.store.reserve(ids);
        self.ids.extend_from_slice(ids);
    }
    pub fn created(&mut self, id: Id) {
        self.created.push(id);
    }
    /// Takes over `other`'s reservations (no re-reserve; `other` releases nothing).
    pub fn absorb(&mut self, mut other: Reservation<'a>) {
        self.ids.append(&mut other.ids);
        self.created.append(&mut other.created);
    }
    /// Releases everything now (also done on drop).
    pub fn release(&mut self) {
        let ids = std::mem::take(&mut self.ids);
        let created = std::mem::take(&mut self.created);
        self.store.unreserve(&ids, &created);
    }
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        self.release();
    }
}

/// Wraps a write transaction's tables plus a commit helper (keeps call sites short).
pub(crate) fn with_write<T>(store: &Store, f: impl FnOnce(&mut Tables<'_>) -> Result<T>) -> Result<T> {
    let tx = store.db.begin_write()?;
    let out = {
        let mut t = Tables::open(&tx)?;
        f(&mut t)?
    };
    tx.commit()?;
    Ok(out)
}

pub(crate) fn now() -> u64 {
    now_ms()
}
