//! Offline store administration (the reactor must be stopped: the index is opened exclusively).
//!
//! ```text
//! reactor-admin rekey     encrypt plaintext objects / rewrap old key ids to the active key,
//!                         compact packs holding superseded copies, rewrap dictionaries
//! reactor-admin status    print the encryption stats (objects per key id, plaintext objects)
//! reactor-admin verify    full consistency check incl. decrypt + decode + hash of every object
//! ```
//!
//! Uses the same environment as the reactor (`REACTOR_STATE_DIR`, `REACTOR_MASTER_KEY*`,
//! `REACTOR_ACTIVE_KEY_ID`, store settings). `rekey` is crash-safe and resumable: rerun it after
//! an interruption and it continues with the objects that still need work.

use core_reactor::crypto;
use core_reactor::evolution::{Engine, EvoConfig};
use core_reactor::store::{Store, StoreConfig};
use std::sync::Arc;
use std::time::Instant;

fn usage() -> ! {
    eprintln!("usage: reactor-admin <rekey|status|verify>");
    std::process::exit(2);
}

fn main() {
    let cmd = std::env::args().nth(1).unwrap_or_else(|| usage());
    let keys = match crypto::KeyRing::from_env() {
        Ok(k) => Arc::new(k),
        Err(e) => {
            eprintln!("reactor-admin: {}", e);
            std::process::exit(2);
        }
    };
    let mut cfg = EvoConfig::from_env();
    cfg.keys = keys.clone();
    cfg.enabled = false;
    let state_dir = cfg.state_dir.clone();
    let engine = Arc::new(Engine::new(cfg));
    let mut scfg = StoreConfig::from_env(&state_dir);
    scfg.fusion = false;
    let store = match Store::open(scfg, engine) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("reactor-admin: cannot open store in {} (is the reactor still running?): {}", state_dir.display(), e);
            std::process::exit(1);
        }
    };
    match cmd.as_str() {
        "rekey" => {
            let Some(active) = keys.active_id() else {
                eprintln!("reactor-admin: rekey needs REACTOR_MASTER_KEY or REACTOR_MASTER_KEYS + REACTOR_ACTIVE_KEY_ID");
                std::process::exit(2);
            };
            let start = Instant::now();
            let mut last = Instant::now();
            println!("rekey: active key {:?}, {} objects to rewrite", active, store.rekey_remaining().unwrap_or(0));
            let r = store.rekey(0, &mut |p| {
                if last.elapsed().as_millis() >= 1000 || p.done == p.total {
                    last = Instant::now();
                    let secs = start.elapsed().as_secs_f64().max(1e-3);
                    println!("rekey: {}/{} objects, {:.1} MiB ({:.1} MiB/s)", p.done, p.total, p.bytes as f64 / 1048576.0, p.bytes as f64 / 1048576.0 / secs);
                }
            });
            match r {
                Ok(rep) => {
                    println!("{}", serde_json::to_string_pretty(&rep).unwrap_or_default());
                    if rep.remaining > 0 || !rep.failed.is_empty() {
                        eprintln!("rekey: {} objects are still not under key {:?} (see failed)", rep.remaining, active);
                        std::process::exit(1);
                    }
                    println!("rekey: done in {:.1} s; every object and dictionary is sealed under {:?}", start.elapsed().as_secs_f64(), active);
                }
                Err(e) => {
                    eprintln!("rekey failed: {}", e);
                    std::process::exit(1);
                }
            }
        }
        "status" => match store.stats() {
            Ok(v) => println!("{}", serde_json::to_string_pretty(&v["encryption"]).unwrap_or_default()),
            Err(e) => {
                eprintln!("reactor-admin: {}", e);
                std::process::exit(1);
            }
        },
        "verify" => match store.verify_index(true) {
            Ok(rep) => {
                println!("{}", serde_json::to_string_pretty(&rep).unwrap_or_default());
                if !rep.ok() {
                    std::process::exit(1);
                }
            }
            Err(e) => {
                eprintln!("reactor-admin: {}", e);
                std::process::exit(1);
            }
        },
        _ => usage(),
    }
}
