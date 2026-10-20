//! Group commit of index transactions for uploads and replica imports.
//!
//! Small files used to pay one redb commit (itself an fsync) each, serialized behind redb's
//! single writer. Writers now fsync + rename their object files in their own thread (in parallel
//! with other writers, striped placement locks), then hand their index changes to a *group
//! commit*: the first writer to arrive becomes the leader, optionally waits a short window
//! (`REACTOR_GROUP_COMMIT_MS`, default 2 ms, and only while other writers are still staging),
//! takes every queued job, applies all of them in ONE write transaction and commits it once.
//! Each writer returns only after its own index entry is durable, and its object data was
//! durable before it submitted, so durability semantics are unchanged: an upload is acknowledged
//! only after `fsync(objects) → rename → index commit`.
//!
//! Small objects (below the pack threshold) are not written by the writers at all: each job
//! carries them, and the leader appends every job's records to the active pack with ONE write and
//! ONE fsync, assigns their locations and only then commits the shared transaction. So a batch of
//! N small uploads costs one pack fsync + one redb commit instead of N × (fsync + rename) + one
//! commit. Durability is unchanged: pack bytes are durable before the index commit, and every
//! writer returns only after both.
//!
//! Failure isolation: if one job's index changes fail, the shared transaction is aborted and the
//! jobs are applied in one transaction each, so a bad job never fails its neighbours.

use super::index::Tables;
use super::ingest::{apply_commit, PendingObject};
use super::pack::PackPin;
use super::{lock, now, Id, Result, Store, StoreError};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

/// Default window: long enough to collect writers that are finishing concurrently, shorter than
/// one commit.
pub const DEFAULT_WINDOW: Duration = Duration::from_millis(2);

/// One writer's index changes (owned so the leader thread can apply them).
pub(crate) struct CommitJob {
    /// Small objects still to append to the pack (by the leader).
    pub packed: Vec<(Id, Vec<u8>)>,
    pub pending_objects: HashMap<Id, PendingObject>,
    pub pending_chunks: HashMap<Id, (Id, u32, u32)>,
    pub file_id: Id,
    pub size: u64,
    pub chunks: Vec<(u64, Id, u32)>,
    pub class: u8,
    pub created_ms: u64,
    pub origin: bool,
    pub pin: bool,
}

type JobResult = Result<(bool, u64)>;

#[derive(Default)]
struct Queue {
    jobs: Vec<(u64, CommitJob)>,
    done: HashMap<u64, JobResult>,
    leader: bool,
    next_ticket: u64,
}

#[derive(Default)]
pub(crate) struct GroupCommit {
    q: Mutex<Queue>,
    cv: Condvar,
    /// Writers currently staging that have not submitted yet (they may submit soon).
    writers: AtomicUsize,
    pub batches: AtomicU64,
    pub jobs: AtomicU64,
    pub max_batch: AtomicU64,
}

impl GroupCommit {
    pub fn writer_started(&self) {
        self.writers.fetch_add(1, Ordering::Relaxed);
    }
    pub fn writer_done(&self) {
        self.writers.fetch_sub(1, Ordering::Relaxed);
    }
}

/// Recreates an error for every job of a failed batch (StoreError is not Clone).
fn dup_err(e: &StoreError) -> StoreError {
    match e {
        StoreError::NotFound => StoreError::NotFound,
        StoreError::Full { needed, used, max } => StoreError::Full {
            needed: *needed,
            used: *used,
            max: *max,
        },
        StoreError::Corrupt(m) => StoreError::Corrupt(m.clone()),
        StoreError::Invalid(m) => StoreError::Invalid(m.clone()),
        StoreError::UnknownDict(d) => StoreError::UnknownDict(*d),
        StoreError::Io(e) => StoreError::Io(std::io::Error::new(e.kind(), e.to_string())),
        StoreError::Db(m) => StoreError::Db(m.clone()),
        StoreError::Injected(p) => StoreError::Injected(p),
        StoreError::KeyUnavailable(m) => StoreError::KeyUnavailable(m.clone()),
        StoreError::Busy(m) => StoreError::Busy(m.clone()),
    }
}

impl Store {
    /// Submits a job and blocks until its index changes are committed (or failed).
    /// The caller has already made the job's object files durable.
    pub(crate) fn group_commit(&self, job: CommitJob) -> JobResult {
        let g = &self.group;
        let mut q = lock(&g.q);
        let ticket = q.next_ticket;
        q.next_ticket += 1;
        q.jobs.push((ticket, job));
        g.writer_done();
        g.cv.notify_all();
        loop {
            if let Some(r) = q.done.remove(&ticket) {
                return r;
            }
            if !q.leader {
                q.leader = true;
                // Short window to let concurrently staging writers join this batch.
                let window = self.cfg.group_commit_window;
                if !window.is_zero() {
                    let deadline = Instant::now() + window;
                    while g.writers.load(Ordering::Relaxed) > 0 {
                        let left = deadline.saturating_duration_since(Instant::now());
                        if left.is_zero() {
                            break;
                        }
                        q =
                            g.cv.wait_timeout(q, left)
                                .unwrap_or_else(|p| p.into_inner())
                                .0;
                    }
                }
                let batch = std::mem::take(&mut q.jobs);
                drop(q);
                let tickets: Vec<u64> = batch.iter().map(|(t, _)| *t).collect();
                // a panic must not leave the followers waiting forever
                let results = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    self.commit_batch(batch)
                }))
                .unwrap_or_else(|_| {
                    tickets
                        .iter()
                        .map(|t| (*t, Err(StoreError::Db("group commit panicked".into()))))
                        .collect()
                });
                q = lock(&g.q);
                q.done.extend(results);
                q.leader = false;
                g.cv.notify_all();
                continue;
            }
            q = g.cv.wait(q).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// Appends every job's small objects to the pack (one write + one fsync for the batch; an
    /// object staged by several jobs is written once) and records their locations in the jobs.
    fn append_batch(&self, batch: &mut [(u64, CommitJob)]) -> Result<PackPin<'_>> {
        let mut seen: HashMap<Id, usize> = HashMap::new();
        let mut order: Vec<(usize, usize)> = Vec::new();
        for (j, (_, job)) in batch.iter().enumerate() {
            for (k, (id, _)) in job.packed.iter().enumerate() {
                if !seen.contains_key(id) {
                    seen.insert(*id, order.len());
                    order.push((j, k));
                }
            }
        }
        if order.is_empty() {
            return Ok(PackPin::none(self));
        }
        let (locs, pin) = {
            let items: Vec<(Id, &[u8])> = order
                .iter()
                .map(|&(j, k)| {
                    let (id, blob) = &batch[j].1.packed[k];
                    (*id, blob.as_slice())
                })
                .collect();
            self.pack_append(&items)?
        };
        for (_, job) in batch.iter_mut() {
            for (id, _) in std::mem::take(&mut job.packed) {
                if let (Some(p), Some(&i)) = (job.pending_objects.get_mut(&id), seen.get(&id)) {
                    p.pack = Some(locs[i]);
                }
            }
        }
        Ok(pin)
    }

    fn commit_batch(&self, mut batch: Vec<(u64, CommitJob)>) -> Vec<(u64, JobResult)> {
        let n = batch.len() as u64;
        self.group.batches.fetch_add(1, Ordering::Relaxed);
        self.group.jobs.fetch_add(n, Ordering::Relaxed);
        self.group.max_batch.fetch_max(n, Ordering::Relaxed);
        crate::metrics::group_commit_batch(n);
        // held until the index transaction(s) below finished
        let _pin = match self
            .append_batch(&mut batch)
            .and_then(|pin| self.fail("pack.before_commit").map(|_| pin))
        {
            Ok(pin) => pin,
            Err(e) => return batch.iter().map(|(t, _)| (*t, Err(dup_err(&e)))).collect(),
        };
        let ts = now();
        let shared = (|| -> Result<Vec<(bool, u64)>> {
            let tx = self.db.begin_write()?;
            let mut v = Vec::with_capacity(batch.len());
            {
                let mut t = Tables::open(&tx)?;
                for (_, job) in &batch {
                    v.push(apply_commit(&mut t, job, ts)?);
                }
            }
            let t = Instant::now();
            tx.commit()?;
            crate::metrics::fsync("index_commit", t.elapsed());
            Ok(v)
        })();
        let mut results: Vec<(u64, JobResult)> = match shared {
            Ok(v) => batch
                .iter()
                .map(|(t, _)| *t)
                .zip(v.into_iter().map(Ok))
                .collect(),
            Err(e) if batch.len() == 1 => vec![(batch[0].0, Err(e))],
            Err(_) => batch
                .iter()
                .map(|(t, job)| (*t, super::with_write(self, |tb| apply_commit(tb, job, ts))))
                .collect(),
        };
        if let Err(e) = self.fail("write.after_commit") {
            for (_, r) in results.iter_mut() {
                if r.is_ok() {
                    *r = Err(dup_err(&e));
                }
            }
        }
        results
    }

    /// `(batches, jobs, max_batch)` of the group commit since startup.
    pub fn group_commit_stats(&self) -> (u64, u64, u64) {
        let g = &self.group;
        (
            g.batches.load(Ordering::Relaxed),
            g.jobs.load(Ordering::Relaxed),
            g.max_batch.load(Ordering::Relaxed),
        )
    }
}
