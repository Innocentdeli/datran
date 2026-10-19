//! Store eviction policy under data gravity (NETWORK_SPEC §2 "Capacity", §4).
//!
//! Over capacity, the store asks the policy for candidates and drops them one by one. A replica
//! is offered only when it is safely replicated: it is not a pinned origin file, this node has
//! not promised (leased) to keep it, and `min(REACTOR_MIN_REPLICAS, cluster size)` *other*
//! healthy holders granted a hold-lease just now. Coldest (lowest local demand) first. The store
//! re-checks `can_evict`, which requires that lease confirmation and blocks new lease grants for
//! the file while it is being dropped. No confirmation, no eviction: a file is never evicted
//! below its replica guarantee (the store then answers 507).

use super::{lock, Cluster};
use crate::state::now_ms;
use crate::store::{EvictionPolicy, FileMeta, Id, Store};
use std::sync::atomic::Ordering;
use std::sync::Weak;

pub struct GravityPolicy {
    cluster: Weak<Cluster>,
}

impl GravityPolicy {
    pub fn new(cluster: Weak<Cluster>) -> GravityPolicy {
        GravityPolicy { cluster }
    }
}

impl EvictionPolicy for GravityPolicy {
    fn can_evict(&self, meta: &FileMeta) -> bool {
        if meta.origin && meta.pins > 0 {
            return false;
        }
        self.cluster.upgrade().is_some_and(|c| c.eviction_allowed(&meta.file_id))
    }

    fn candidates(&self, _store: &Store, need_bytes: u64) -> Vec<Id> {
        self.cluster.upgrade().map(|c| c.eviction_candidates(need_bytes)).unwrap_or_default()
    }
}

impl Cluster {
    fn eviction_allowed(&self, file: &Id) -> bool {
        let now = now_ms();
        let mut l = lock(&self.leases);
        if l.active(file, now) || l.dropping.contains_key(file) {
            return false;
        }
        if lock(&self.confirmed).get(file).is_some_and(|until| *until > now) {
            l.dropping.insert(*file, now);
            return true;
        }
        false
    }

    /// Cold replicas whose replication was just confirmed by leases (runs on the caller's
    /// blocking thread; the lease requests run on a private runtime so this works from any
    /// context).
    fn eviction_candidates(&self, need_bytes: u64) -> Vec<Id> {
        let now = now_ms();
        let mut files: Vec<FileMeta> = self
            .store
            .list_files(None, 10_000)
            .unwrap_or_default()
            .into_iter()
            .filter(|m| !(m.origin && m.pins > 0) && !self.has_active_lease(&m.file_id))
            .collect();
        if files.is_empty() {
            return Vec::new();
        }
        let need = self.min_replicas_effective();
        files.retain(|m| self.holders(&m.file_id).len() >= need);
        files.sort_by(|a, b| self.demand(&a.file_id).total_cmp(&self.demand(&b.file_id)).then(b.size.cmp(&a.size)));
        let ttl = self.cfg.lease_ttl.as_millis() as u64;
        let run = || {
            let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().ok()?;
            Some(rt.block_on(async {
                let mut out = Vec::new();
                let mut freed = 0u64;
                for m in &files {
                    if freed >= need_bytes.saturating_mul(2) {
                        break;
                    }
                    // unpooled HTTP (this runtime is dropped afterwards); QUIC requests run on
                    // the main runtime inside the peer client
                    let (granted, _) = self.acquire_leases(false, &m.file_id, need, None).await;
                    if granted >= need {
                        lock(&self.confirmed).insert(m.file_id, now + ttl);
                        self.metrics.evictions_confirmed.fetch_add(1, Ordering::Relaxed);
                        out.push(m.file_id);
                        freed += m.size;
                    }
                }
                out
            }))
        };
        std::thread::scope(|s| s.spawn(run).join().ok().flatten()).unwrap_or_default()
    }
}
