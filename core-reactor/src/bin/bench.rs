//! Evolution bench: `cargo run --release --bin bench -- <folder> [--generations N] [--seed S]`
//!
//! Loads files from a folder (recursively), classifies them, evolves recipes per class on the
//! reservoir (exactly like the server, but without persistence), then measures the baseline
//! (zstd-3) and the champion on the class's *held-out* files only. Files are fed in order, so
//! file `i` gets upload index `i`; odd indices are held out (never used to train a dictionary).
//! Ratios are aggregate (total original / total compressed); throughput is aggregate MiB/s of
//! one single-threaded pass.

use core_reactor::classify;
use core_reactor::codec::{decode_v2, DictId};
use core_reactor::evolution::{score_recipe, Engine, EvoConfig};
use core_reactor::recipe::Recipe;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

const MAX_FILE: usize = 16 << 20;
const MAX_FILES: usize = 5000;

fn collect(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if p.is_dir() {
            if !matches!(name.as_str(), ".git" | "target" | "node_modules" | ".next") {
                collect(&p, out);
            }
        } else if p.is_file() {
            out.push(p);
        }
    }
}

struct Measure {
    ratio: f64,
    enc_mib_s: f64,
    dec_mib_s: f64,
}

fn measure(recipe: &Recipe, files: &[Arc<Vec<u8>>], dict: Option<Arc<Vec<u8>>>) -> Option<Measure> {
    let id = recipe.dict_id();
    let lookup = |i: &DictId| if Some(*i) == id { dict.clone() } else { None };
    let (mut orig, mut comp, mut enc, mut dec) = (0usize, 0usize, 0f64, 0f64);
    for f in files {
        let t = Instant::now();
        let blob = recipe.encode(f, dict.as_deref().map(|d| d.as_slice())).ok()?;
        enc += t.elapsed().as_secs_f64();
        let t = Instant::now();
        let out = decode_v2(&blob, usize::MAX, &lookup).ok()?;
        dec += t.elapsed().as_secs_f64();
        if out.as_slice() != f.as_slice() {
            return None;
        }
        orig += f.len();
        // what /compress would actually store: never more than legacy raw
        comp += blob.len().min(f.len() + 1);
    }
    let mib = orig as f64 / (1024.0 * 1024.0);
    Some(Measure { ratio: orig as f64 / comp.max(1) as f64, enc_mib_s: mib / enc.max(1e-9), dec_mib_s: mib / dec.max(1e-9) })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut folder = None;
    let mut generations = 8usize;
    let mut seed = 1u64;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--generations" => {
                generations = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(generations);
                i += 1;
            }
            "--seed" => {
                seed = args.get(i + 1).and_then(|v| v.parse().ok()).unwrap_or(seed);
                i += 1;
            }
            other => folder = Some(PathBuf::from(other)),
        }
        i += 1;
    }
    let Some(folder) = folder else {
        eprintln!("usage: bench <folder> [--generations N] [--seed S]");
        std::process::exit(2);
    };

    let mut paths = Vec::new();
    collect(&folder, &mut paths);
    let mut by_class: BTreeMap<&'static str, Vec<Arc<Vec<u8>>>> = BTreeMap::new();
    for p in &paths {
        let Ok(data) = std::fs::read(p) else { continue };
        if data.is_empty() || data.len() > MAX_FILE {
            continue;
        }
        by_class.entry(classify::classify(&data, None)).or_default().push(Arc::new(data));
    }

    let state_dir = std::env::temp_dir().join(format!("core-reactor-bench-{}", std::process::id()));
    let mut cfg = EvoConfig::from_env();
    cfg.state_dir = state_dir.clone();
    cfg.persist = false;
    cfg.enabled = true;
    cfg.seed = Some(seed);
    cfg.max_output = usize::MAX;
    let engine = Engine::new(cfg);
    println!(
        "corpus: {} ({} files), generations {}, weights enc {} dec {}, seed {}",
        folder.display(),
        by_class.values().map(|v| v.len()).sum::<usize>(),
        generations,
        engine.cfg.w_enc,
        engine.cfg.w_dec,
        seed
    );
    println!(
        "{:<18} {:>11} {:>9} | {:>7} {:>8} {:>8} {:>7} | {:<28} {:>7} {:>8} {:>8} {:>7} {:>6}",
        "class", "train/held", "held MiB", "zstd3 x", "enc MB/s", "dec MB/s", "fit", "champion", "ratio x", "enc MB/s", "dec MB/s", "fit", "evo s"
    );
    for (class, files) in &by_class {
        let held: Vec<Arc<Vec<u8>>> = files.iter().skip(1).step_by(2).cloned().collect();
        let split = format!("{}/{}", files.len() - held.len(), held.len());
        let mib = held.iter().map(|f| f.len()).sum::<usize>() as f64 / (1024.0 * 1024.0);
        if !classify::is_evolvable(class) {
            println!("{:<18} {:>11} {:>9.2} | not evolved (stored as legacy raw)", class, split, mib);
            continue;
        }
        for f in files {
            engine.observe(class, f);
        }
        let t = Instant::now();
        for _ in 0..generations {
            engine.run_generation(class);
        }
        let evo_s = t.elapsed().as_secs_f64();
        let Some(champ) = engine.champion(class) else { continue };
        let dict = champ.recipe.dict_id().and_then(|id| engine.dicts.get(&id));
        if held.is_empty() {
            println!("{:<18} {:>11} {:>9} | no held-out file; not measured (champion {})", class, split, "-", champ.recipe.label());
            continue;
        }
        // baseline fitness on the same held-out reservoir samples the champion was scored on
        let base_fit = score_recipe(&Recipe::baseline(), &engine.held_out(class), None, engine.cfg.w_enc, engine.cfg.w_dec, usize::MAX)
            .map(|s| s.fitness)
            .unwrap_or(f64::NAN);
        let base = measure(&Recipe::baseline(), &held, None);
        let ch = measure(&champ.recipe, &held, dict);
        match (base, ch) {
            (Some(b), Some(c)) => println!(
                "{:<18} {:>11} {:>9.2} | {:>7.3} {:>8.1} {:>8.1} {:>7.3} | {:<28} {:>7.3} {:>8.1} {:>8.1} {:>7.3} {:>6.1}",
                class,
                split,
                mib,
                b.ratio,
                b.enc_mib_s,
                b.dec_mib_s,
                base_fit,
                champ.recipe.label(),
                c.ratio,
                c.enc_mib_s,
                c.dec_mib_s,
                champ.score.fitness,
                evo_s
            ),
            _ => println!("{:<18} measurement failed", class),
        }
    }
    println!("notes: all ratios/throughput are on HELD-OUT files only (odd file index per class; single thread, this machine).");
    println!("       dictionaries are trained only on train-split reservoir samples; fitness is on held-out reservoir samples.");
    let _ = std::fs::remove_dir_all(state_dir);
}
