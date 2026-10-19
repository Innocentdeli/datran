//! Process-wide compression parallelism (`REACTOR_COMPRESS_THREADS`).
//!
//! One fixed pool of worker threads is shared by every store and every concurrent upload, so many
//! simultaneous uploads queue their chunk-compression jobs on the same threads instead of each
//! spawning their own (no core oversubscription). The pool is created on first use with
//! [`configured_threads`] threads. Evolution fitness scoring never uses it (recipe timings must stay
//! single-threaded and comparable).

use std::sync::mpsc;
use std::sync::{Arc, Mutex, OnceLock};

type Job = Box<dyn FnOnce() + Send + 'static>;

/// `min(available_parallelism, REACTOR_COMPRESS_THREADS)`; unset or 0 = every core.
pub fn configured_threads() -> usize {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    match std::env::var("REACTOR_COMPRESS_THREADS").ok().and_then(|v| v.trim().parse::<usize>().ok()) {
        Some(n) if n > 0 => n.min(cores),
        _ => cores,
    }
}

pub(crate) struct Pool {
    tx: Mutex<mpsc::Sender<Job>>,
    threads: usize,
}

static POOL: OnceLock<Pool> = OnceLock::new();

impl Pool {
    fn start(threads: usize) -> Pool {
        let (tx, rx) = mpsc::channel::<Job>();
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..threads {
            let rx = rx.clone();
            let spawned = std::thread::Builder::new().name(format!("reactor-compress-{}", i)).spawn(move || loop {
                let job = match rx.lock() {
                    Ok(g) => g.recv(),
                    Err(p) => p.into_inner().recv(),
                };
                match job {
                    Ok(job) => job(),
                    Err(_) => break,
                }
            });
            if spawned.is_err() {
                tracing::warn!("could not spawn compression thread {}", i);
            }
        }
        Pool { tx: Mutex::new(tx), threads }
    }

    /// Queues `job`; returns it back when the pool cannot run it (the caller runs it inline).
    pub fn spawn(&self, job: Job) -> Result<(), Job> {
        let tx = self.tx.lock().unwrap_or_else(|p| p.into_inner());
        tx.send(job).map_err(|e| e.0)
    }

    pub fn threads(&self) -> usize {
        self.threads
    }
}

/// The shared pool (started on first call).
pub(crate) fn pool() -> &'static Pool {
    POOL.get_or_init(|| Pool::start(configured_threads().max(1)))
}

/// Size of the shared pool if it has been started.
pub fn pool_threads() -> Option<usize> {
    POOL.get().map(|p| p.threads())
}
