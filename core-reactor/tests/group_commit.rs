//! Group commit of the store's index transactions: many concurrent small puts are batched into
//! fewer commits, every put is durable when it returns, duplicates are counted exactly.

mod common;

use common::*;
use core_reactor::evolution::Engine;
use core_reactor::store::{sha256, PutOptions, Store, StoreConfig};
use std::sync::Arc;
use std::time::Duration;

fn open(dir: &std::path::Path) -> Store {
    let mut ec = test_config(&dir.join("evo"), 1);
    ec.persist = false;
    let mut cfg = StoreConfig::new(dir.join("store"));
    cfg.group_commit_window = Duration::from_millis(2);
    Store::open(cfg, Arc::new(Engine::new(ec))).unwrap()
}

#[test]
fn concurrent_small_puts_are_group_committed_and_durable() {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(open(dir.path()));
    let opts = PutOptions {
        content_type: None,
        sample: false,
    };
    const THREADS: u64 = 24;
    const PER: u64 = 25;
    let shared = text(3_000, 999);
    std::thread::scope(|s| {
        for t in 0..THREADS {
            let store = store.clone();
            let opts = opts.clone();
            let shared = shared.clone();
            s.spawn(move || {
                for i in 0..PER {
                    let data = if i == 0 {
                        shared.clone()
                    } else {
                        text(1_000 + (t * PER + i) as usize % 3_000, t * 1000 + i)
                    };
                    let out = store.put_bytes(&data, &opts).unwrap();
                    assert_eq!(out.file_id, sha256(&data));
                    // acknowledged => readable (and durable, checked after reopen)
                    assert_eq!(store.read_to_vec(&out.file_id, None).unwrap(), data);
                }
            });
        }
    });
    let (batches, jobs, max_batch) = store.group_commit_stats();
    assert_eq!(jobs, THREADS * PER);
    assert!(
        batches < jobs,
        "concurrent puts shared commits: {} batches for {} puts",
        batches,
        jobs
    );
    assert!(max_batch > 1);
    assert_eq!(
        store.file_meta(&sha256(&shared)).unwrap().unwrap().pins,
        THREADS,
        "duplicate puts counted exactly"
    );
    assert!(store.verify_index(true).unwrap().ok());

    // everything acknowledged survives a restart
    drop(store);
    let store = open(dir.path());
    let rep = store.verify_index(true).unwrap();
    assert!(rep.ok(), "{:?}", rep.problems);
    assert_eq!(rep.files, THREADS * (PER - 1) + 1);
    for t in 0..THREADS {
        for i in 1..PER {
            let data = text(1_000 + (t * PER + i) as usize % 3_000, t * 1000 + i);
            assert_eq!(store.read_to_vec(&sha256(&data), None).unwrap(), data);
        }
    }
}

#[test]
fn sequential_puts_do_not_wait_for_the_window() {
    let dir = tempfile::tempdir().unwrap();
    let mut ec = test_config(&dir.path().join("evo"), 1);
    ec.persist = false;
    let mut cfg = StoreConfig::new(dir.path().join("store"));
    cfg.group_commit_window = Duration::from_millis(100);
    let store = Store::open(cfg, Arc::new(Engine::new(ec))).unwrap();
    let opts = PutOptions {
        content_type: None,
        sample: false,
    };
    let t = std::time::Instant::now();
    for i in 0..10 {
        store.put_bytes(&text(2_000, i), &opts).unwrap();
    }
    // a lone writer never waits for others: 10 puts finish well under 10 × 100 ms
    assert!(
        t.elapsed() < Duration::from_millis(900),
        "{:?}",
        t.elapsed()
    );
    assert_eq!(store.group_commit_stats().1, 10);
}
