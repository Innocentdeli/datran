//! Store administration.
//!
//! ```text
//! reactor-admin rekey     encrypt plaintext objects / rewrap old key ids to the active key,
//!                         compact packs holding superseded copies, rewrap dictionaries   (offline)
//! reactor-admin status    print the encryption stats (objects per key id, plaintext objects) (offline)
//! reactor-admin verify    full consistency check incl. decrypt + decode + hash of every object (offline)
//! reactor-admin backup <dest> [--previous <dir>] [--url <reactor url>]
//!                         consistent snapshot of index + objects + packs + dicts + state; works
//!                         while the reactor runs (then via POST /store/backup, see below)
//! reactor-admin restore <backup> <state-dir> [--force]
//!                         verify every file against the manifest, restore, deep-verify
//! ```
//!
//! Uses the same environment as the reactor (`REACTOR_STATE_DIR`, `REACTOR_MASTER_KEY*`,
//! `REACTOR_ACTIVE_KEY_ID`, store settings). `rekey` is crash-safe and resumable: rerun it after
//! an interruption and it continues with the objects that still need work.
//!
//! `backup` opens the store directly when the reactor is stopped. When the reactor holds the
//! index (it is running), it asks the reactor to take the backup itself: `POST /store/backup`
//! on `--url` (default `http://127.0.0.1:$REACTOR_PORT`, token `REACTOR_TOKEN`). The reactor
//! only writes below its `REACTOR_BACKUP_DIR`, so `<dest>` / `--previous` must then be inside
//! that directory (given relative to it, or as a path inside it).

use core_reactor::crypto;
use core_reactor::evolution::{Engine, EvoConfig};
use core_reactor::store::backup::{self, BackupReport};
use core_reactor::store::{Store, StoreConfig, StoreError};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

fn usage() -> ! {
    eprintln!("usage: reactor-admin <rekey|status|verify>\n       reactor-admin backup <dest> [--previous <dir>] [--url <url>]\n       reactor-admin restore <backup> <state-dir> [--force]");
    std::process::exit(2);
}

fn die(msg: impl std::fmt::Display) -> ! {
    eprintln!("reactor-admin: {}", msg);
    std::process::exit(1);
}

fn keys() -> Arc<crypto::KeyRing> {
    match crypto::KeyRing::from_env() {
        Ok(k) => Arc::new(k),
        Err(e) => {
            eprintln!("reactor-admin: {}", e);
            std::process::exit(2);
        }
    }
}

fn open_store(cfg: EvoConfig, scfg: StoreConfig) -> core_reactor::store::Result<Store> {
    let engine = Arc::new(Engine::new(cfg));
    Store::open(scfg, engine)
}

fn admin_config(keys: &Arc<crypto::KeyRing>) -> (EvoConfig, StoreConfig) {
    let mut cfg = EvoConfig::from_env();
    cfg.keys = keys.clone();
    cfg.enabled = false;
    let mut scfg = StoreConfig::from_env(&cfg.state_dir);
    scfg.fusion = false;
    (cfg, scfg)
}

fn locked(e: &StoreError) -> bool {
    let s = e.to_string().to_ascii_lowercase();
    s.contains("already open") || s.contains("lock")
}

fn print_backup(rep: &BackupReport) {
    println!("{}", serde_json::to_string_pretty(rep).unwrap_or_default());
    println!(
        "backup: {} files, {:.1} MiB total, {:.1} MiB copied ({} objects copied, {} reused; {} packs copied, {} reused) in {:.1} s{}",
        rep.files,
        rep.bytes_total as f64 / 1048576.0,
        rep.bytes_copied as f64 / 1048576.0,
        rep.objects_copied,
        rep.objects_reused,
        rep.packs_copied,
        rep.packs_reused,
        rep.seconds,
        if rep.key_ids.is_empty() { String::new() } else { format!("; ciphertext under key ids {:?} (keys NOT included)", rep.key_ids) }
    );
}

/// `<p>` relative to `REACTOR_BACKUP_DIR` for the online path.
fn relative_to_backup_root(p: &str) -> Result<String, String> {
    let path = Path::new(p);
    if path.is_relative() && !p.contains("..") {
        return Ok(p.replace('\\', "/"));
    }
    let root = std::env::var_os("REACTOR_BACKUP_DIR").map(PathBuf::from).ok_or("the reactor is running: an online backup goes below its REACTOR_BACKUP_DIR; set it here too or pass a path relative to it")?;
    let root = std::fs::canonicalize(&root).map_err(|e| format!("REACTOR_BACKUP_DIR: {}", e))?;
    let abs = std::fs::canonicalize(path).or_else(|_| path.parent().map(std::fs::canonicalize).unwrap_or(Ok(PathBuf::new())).map(|d| d.join(path.file_name().unwrap_or_default()))).map_err(|e| e.to_string())?;
    abs.strip_prefix(&root)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .map_err(|_| format!("{} is not inside REACTOR_BACKUP_DIR {}", p, root.display()))
}

fn online_backup(url: &str, dest: &str, previous: Option<&str>) -> Result<BackupReport, String> {
    let dest = relative_to_backup_root(dest)?;
    let previous = previous.map(relative_to_backup_root).transpose()?;
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    rt.block_on(async {
        let client = reqwest::Client::builder().build().map_err(|e| e.to_string())?;
        let mut req = client.post(format!("{}/store/backup", url.trim_end_matches('/'))).json(&serde_json::json!({ "dest": dest, "previous": previous }));
        if let Ok(t) = std::env::var("REACTOR_TOKEN") {
            req = req.header("x-reactor-token", t);
        }
        let resp = req.send().await.map_err(|e| format!("cannot reach the reactor at {}: {}", url, e))?;
        let status = resp.status();
        let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("reactor refused the backup ({}): {}", status, body["error"].as_str().unwrap_or("?")));
        }
        serde_json::from_value::<BackupReport>(body).map_err(|e| e.to_string())
    })
}

fn cmd_backup(args: &[String]) {
    let mut dest = None;
    let mut previous = None;
    let mut url = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--previous" => {
                previous = args.get(i + 1).cloned();
                i += 1;
            }
            "--url" => {
                url = args.get(i + 1).cloned();
                i += 1;
            }
            s if dest.is_none() && !s.starts_with("--") => dest = Some(s.to_string()),
            _ => usage(),
        }
        i += 1;
    }
    let Some(dest) = dest else { usage() };
    let keys = keys();
    let (cfg, scfg) = admin_config(&keys);
    match open_store(cfg, scfg) {
        Ok(store) => match store.backup(Path::new(&dest), previous.as_deref().map(Path::new)) {
            Ok(rep) => print_backup(&rep),
            Err(e) => die(format!("backup failed: {}", e)),
        },
        Err(e) if locked(&e) => {
            let url = url.unwrap_or_else(|| format!("http://127.0.0.1:{}", std::env::var("REACTOR_PORT").unwrap_or_else(|_| "3005".into())));
            println!("backup: the reactor is running; asking it for an online backup via {}", url);
            match online_backup(&url, &dest, previous.as_deref()) {
                Ok(rep) => print_backup(&rep),
                Err(e) => die(format!("backup failed: {}", e)),
            }
        }
        Err(e) => die(format!("cannot open the store: {}", e)),
    }
}

fn cmd_restore(args: &[String]) {
    let force = args.iter().any(|a| a == "--force");
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let [src, dst] = pos.as_slice() else { usage() };
    let keys = keys();
    let k2 = keys.clone();
    let verify = move |state_dir: &Path| {
        let mut cfg = EvoConfig::new(state_dir);
        cfg.keys = k2.clone();
        cfg.enabled = false;
        let mut scfg = StoreConfig::new(state_dir.join("store"));
        scfg.fusion = false;
        let store = open_store(cfg, scfg)?;
        println!("restore: files copied and hash-checked; running deep verify (decrypt + decode + hash of every object)");
        store.verify_index(true)
    };
    match backup::restore(Path::new(src.as_str()), Path::new(dst.as_str()), force, &keys, &verify) {
        Ok(rep) => {
            println!("{}", serde_json::to_string_pretty(&rep).unwrap_or_default());
            println!("restore: OK — {} files, {:.1} MiB, deep verify clean, in {:.1} s", rep.files, rep.bytes as f64 / 1048576.0, rep.seconds);
        }
        Err(e) => die(format!("restore failed (nothing usable was left in {}): {}", dst, e)),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(cmd) = args.first().cloned() else { usage() };
    match cmd.as_str() {
        "backup" => return cmd_backup(&args[1..]),
        "restore" => return cmd_restore(&args[1..]),
        "rekey" | "status" | "verify" => {}
        _ => usage(),
    }
    let keys = keys();
    let (cfg, scfg) = admin_config(&keys);
    let state_dir = cfg.state_dir.clone();
    let store = match open_store(cfg, scfg) {
        Ok(s) => s,
        Err(e) => die(format!("cannot open store in {} (is the reactor still running?): {}", state_dir.display(), e)),
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
                Err(e) => die(format!("rekey failed: {}", e)),
            }
        }
        "status" => match store.stats() {
            Ok(v) => println!("{}", serde_json::to_string_pretty(&v["encryption"]).unwrap_or_default()),
            Err(e) => die(e),
        },
        _ => match store.verify_index(true) {
            Ok(rep) => {
                println!("{}", serde_json::to_string_pretty(&rep).unwrap_or_default());
                if !rep.ok() {
                    std::process::exit(1);
                }
            }
            Err(e) => die(e),
        },
    }
}
