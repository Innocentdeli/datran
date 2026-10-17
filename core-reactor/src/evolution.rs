//! Evolution of compression recipes per content class (spec §3).

use crate::classify::{self, MEDIA_COMPRESSED};
use crate::codec::{self, Codec, DictId, Filter, STRIDES};
use crate::dicts::{DictStore, MAX_DICT_BYTES};
use crate::reactor::DiocomNativeReactor;
use crate::recipe::Recipe;
use crate::state::{self, Champion, ClassStats, Member, PersistedClass, PersistedState, Score};
use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

const MIB: f64 = 1024.0 * 1024.0;
pub const RESERVOIR_CAP: usize = 32;
pub const POPULATION_SIZE: usize = 12;
pub const ELITE: usize = 4;
const MAX_PENDING_IMMIGRANTS: usize = 8;
const DICT_MIN_SAMPLES: usize = 16;
const DICT_MAX_MEDIAN: usize = 64 * 1024;
/// Retrain a class dictionary after this many new uploads were seen.
const DICT_RETRAIN_AFTER: u64 = 64;

#[derive(Clone, Debug)]
pub struct EvoConfig {
    pub enabled: bool,
    pub w_enc: f64,
    pub w_dec: f64,
    pub sample_bytes_max: usize,
    pub interval: Duration,
    pub seed: Option<u64>,
    pub max_output: usize,
    pub state_dir: PathBuf,
    /// Write `state.json` (disabled for the bench).
    pub persist: bool,
    /// `REACTOR_MT_THRESHOLD` (default 8 MiB): `/compress` bodies larger than this use zstd's
    /// multithreaded encoder (zstd recipes only); 0 disables. Fitness scoring never does.
    pub mt_threshold: usize,
    /// zstd worker threads for those bodies (`REACTOR_COMPRESS_THREADS`, default every core).
    pub mt_workers: u32,
}

fn env_parse<T: std::str::FromStr>(name: &str) -> Option<T> {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok())
}

impl EvoConfig {
    pub fn new(state_dir: impl Into<PathBuf>) -> EvoConfig {
        EvoConfig {
            enabled: true,
            w_enc: 0.5,
            w_dec: 1.0,
            sample_bytes_max: 1024 * 1024,
            interval: Duration::from_secs(30),
            seed: None,
            max_output: crate::reactor::max_output_bytes(),
            state_dir: state_dir.into(),
            persist: true,
            mt_threshold: 8 << 20,
            mt_workers: crate::workers::configured_threads().min(256) as u32,
        }
    }

    pub fn from_env() -> EvoConfig {
        let mut c = EvoConfig::new(
            std::env::var("REACTOR_STATE_DIR").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "./reactor-state".into()),
        );
        if let Ok(v) = std::env::var("REACTOR_EVOLVE") {
            c.enabled = !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off");
        }
        if let Some(w) = env_parse::<f64>("REACTOR_WEIGHT_ENCODE").filter(|w| w.is_finite() && *w >= 0.0) {
            c.w_enc = w;
        }
        if let Some(w) = env_parse::<f64>("REACTOR_WEIGHT_DECODE").filter(|w| w.is_finite() && *w >= 0.0) {
            c.w_dec = w;
        }
        if let Some(n) = env_parse::<usize>("REACTOR_SAMPLE_BYTES_MAX").filter(|n| *n > 0) {
            c.sample_bytes_max = n;
        }
        if let Some(ms) = env_parse::<u64>("REACTOR_EVOLVE_INTERVAL_MS") {
            c.interval = Duration::from_millis(ms);
        }
        c.seed = env_parse::<u64>("REACTOR_EVOLVE_SEED");
        if let Some(n) = env_parse::<usize>("REACTOR_MT_THRESHOLD") {
            c.mt_threshold = n;
        }
        c
    }
}

/// The 12 seeded default recipes (spec §3). `[0]` is the baseline (zstd-3).
/// Includes the procedural codec (NETWORK_SPEC §1) for every evolvable class (`media/compressed`
/// has no population); it only wins on data that really is fills / counters / periodic patterns.
pub fn seed_population() -> Vec<Recipe> {
    vec![
        Recipe::new(Codec::Zstd, 3),
        Recipe::new(Codec::Zstd, 9),
        Recipe::new(Codec::Zstd, 19),
        Recipe::new(Codec::Brotli, 5),
        Recipe::new(Codec::Brotli, 9),
        Recipe::new(Codec::Lz4, 0),
        Recipe::new(Codec::Deflate, 6),
        Recipe::new(Codec::Zstd, 9).with_filter(Filter::Shuffle, 4),
        Recipe::new(Codec::Zstd, 9).with_filter(Filter::Shuffle, 8),
        Recipe::new(Codec::Zstd, 3).with_filter(Filter::Delta, 4),
        Recipe::new(Codec::Procedural, 3),
        Recipe::new(Codec::Zstd, 1),
    ]
}

/// Scores a recipe on samples: mean of `ln(orig/compressed) − w_enc·enc_s/MiB − w_dec·dec_s/MiB`,
/// each sample verified lossless. `None` = failed (fitness −∞) or nothing to score.
pub fn score_recipe(
    recipe: &Recipe,
    samples: &[Arc<Vec<u8>>],
    dict: Option<Arc<Vec<u8>>>,
    w_enc: f64,
    w_dec: f64,
    limit: usize,
) -> Option<Score> {
    let dict_id = recipe.dict_id();
    if dict_id.is_some() && dict.is_none() {
        return None;
    }
    let lookup = |id: &DictId| if Some(*id) == dict_id { dict.clone() } else { None };
    let (mut sum_ln, mut sum_enc, mut sum_dec) = (0.0f64, 0.0f64, 0.0f64);
    let (mut n, mut bytes, mut enc_total, mut dec_total) = (0usize, 0usize, 0.0f64, 0.0f64);
    for s in samples.iter().filter(|s| !s.is_empty()) {
        let t = Instant::now();
        let blob = recipe.encode(s, dict.as_deref().map(|d| d.as_slice())).ok()?;
        let enc = t.elapsed().as_secs_f64();
        let t = Instant::now();
        let out = codec::decode_v2(&blob, limit, &lookup).ok()?;
        let dec = t.elapsed().as_secs_f64();
        if out.as_slice() != s.as_slice() {
            return None;
        }
        let mib = s.len() as f64 / MIB;
        sum_ln += (s.len() as f64 / blob.len() as f64).ln();
        sum_enc += enc / mib;
        sum_dec += dec / mib;
        n += 1;
        bytes += s.len();
        enc_total += enc;
        dec_total += dec;
    }
    if n == 0 {
        return None;
    }
    let nf = n as f64;
    let fitness = (sum_ln - w_enc * sum_enc - w_dec * sum_dec) / nf;
    if !fitness.is_finite() {
        return None;
    }
    Some(Score {
        fitness,
        ratio: (sum_ln / nf).exp(),
        enc_mib_s: bytes as f64 / MIB / enc_total.max(1e-9),
        dec_mib_s: bytes as f64 / MIB / dec_total.max(1e-9),
        samples: n,
    })
}

fn cmp_members(a: &Member, b: &Member) -> std::cmp::Ordering {
    let fa = a.score.as_ref().map(|s| s.fitness).unwrap_or(f64::NEG_INFINITY);
    let fb = b.score.as_ref().map(|s| s.fitness).unwrap_or(f64::NEG_INFINITY);
    fb.partial_cmp(&fa).unwrap_or(std::cmp::Ordering::Equal).then_with(|| a.recipe.cmp(&b.recipe))
}

pub fn crossover(a: &Recipe, b: &Recipe) -> Recipe {
    Recipe { filter: b.filter, stride: b.stride, ..a.clone() }
}

pub fn mutate(r: &mut Recipe, rng: &mut ChaCha8Rng, class_dict: Option<&str>) {
    let ops = if rng.gen_bool(0.3) { 2 } else { 1 };
    for _ in 0..ops {
        match rng.gen_range(0..100) {
            0..=7 => {
                let others: Vec<Codec> = Codec::ALL.iter().copied().filter(|c| *c != r.codec).collect();
                let c = others[rng.gen_range(0..others.len())];
                *r = Recipe::new(c, Recipe::default_level(c)).with_filter(r.filter, r.stride);
            }
            8..=44 => {
                let (lo, hi) = Recipe::level_range(r.codec);
                if lo < hi {
                    let d = [-2, -1, 1, 2][rng.gen_range(0..4)];
                    r.level = (r.level + d).clamp(lo, hi);
                }
            }
            45..=59 => {
                if let Some((lo, hi)) = Recipe::window_range(r.codec) {
                    r.window_log = match r.window_log {
                        None => Some(rng.gen_range(lo.max(15)..=hi.min(24))),
                        Some(_) if rng.gen_bool(0.2) => None,
                        Some(w) => Some(if rng.gen_bool(0.5) { w + 1 } else { w - 1 }.clamp(lo, hi)),
                    };
                }
            }
            60..=84 => {
                let others: Vec<Filter> = Filter::ALL.iter().copied().filter(|f| *f != r.filter).collect();
                r.filter = others[rng.gen_range(0..others.len())];
                r.stride = if r.filter == Filter::None { 0 } else { STRIDES[rng.gen_range(0..4)] };
            }
            85..=94 => {
                if r.filter != Filter::None {
                    r.stride = STRIDES[rng.gen_range(0..4)];
                }
            }
            _ => {
                if r.codec == Codec::Zstd {
                    if let Some(d) = class_dict {
                        r.dict = if r.dict.is_some() { None } else { Some(d.to_string()) };
                    }
                }
            }
        }
    }
}

/// A reservoir sample tagged with its upload index (`seq`, 0-based count of sampled uploads).
#[derive(Clone)]
struct Sample {
    seq: u64,
    data: Arc<Vec<u8>>,
}

/// Deterministic train/held-out split: odd upload indices are held out. Dictionaries are trained
/// only on the train split; recipes are scored on the held-out split.
pub fn is_held_out(seq: u64) -> bool {
    seq % 2 == 1
}

/// Minimum held-out samples required before a dictionary may be trained.
pub const DICT_MIN_HELD_OUT: usize = 4;

#[derive(Default)]
struct Reservoir {
    samples: Vec<Sample>,
    seen: u64,
    version: u64,
}

struct ClassEvo {
    generation: u64,
    population: Vec<Member>,
    champion: Option<Champion>,
    pending: Vec<Recipe>,
    dicts: Vec<String>,
    stats: ClassStats,
    reservoir: Reservoir,
    scored_version: u64,
    last_run: Option<Instant>,
    dict_trained_at_seen: Option<u64>,
    /// Upload indices used to train dictionaries in this process (memory only).
    trained_seqs: HashSet<u64>,
}

impl ClassEvo {
    fn new(class: &str) -> ClassEvo {
        let population = if classify::is_evolvable(class) {
            seed_population()
                .into_iter()
                .map(|recipe| Member { recipe, score: None, origin: "seed".into() })
                .collect()
        } else {
            Vec::new()
        };
        ClassEvo {
            generation: 0,
            population,
            champion: None,
            pending: Vec::new(),
            dicts: Vec::new(),
            stats: ClassStats::default(),
            reservoir: Reservoir::default(),
            scored_version: 0,
            last_run: None,
            dict_trained_at_seen: None,
            trained_seqs: HashSet::new(),
        }
    }

    fn dirty(&self) -> bool {
        !self.reservoir.samples.is_empty()
            && (self.reservoir.version != self.scored_version || !self.pending.is_empty())
    }
}

struct Inner {
    classes: BTreeMap<&'static str, ClassEvo>,
    rng: ChaCha8Rng,
}

impl Inner {
    fn class(&mut self, class: &'static str) -> &mut ClassEvo {
        self.classes.entry(class).or_insert_with(|| ClassEvo::new(class))
    }
}

/// Result of one `/compress`.
#[derive(Debug, Clone)]
pub struct CompressOutcome {
    pub class: &'static str,
    /// Recipe used for a v2 blob; `None` when legacy raw was emitted.
    pub recipe: Option<Recipe>,
    pub blob: Vec<u8>,
    pub entropy: f64,
    pub note: Option<String>,
}

/// Summary of one generation.
#[derive(Debug, Clone)]
pub struct GenReport {
    pub class: &'static str,
    pub generation: u64,
    pub champion: Option<Champion>,
    /// Every recipe scored this generation, best first.
    pub scored: Vec<Member>,
    pub dict_trained: Option<String>,
    /// Upload indices of the samples a dictionary was trained on this generation (train split).
    pub dict_train_seqs: Vec<u64>,
    /// Upload indices of the samples every recipe was scored on (held-out split).
    pub scored_seqs: Vec<u64>,
}

pub struct Engine {
    pub cfg: EvoConfig,
    pub dicts: Arc<DictStore>,
    inner: Mutex<Inner>,
    gen_lock: Mutex<()>,
    save_lock: Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

impl Engine {
    pub fn new(cfg: EvoConfig) -> Engine {
        let seed = cfg.seed.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0x5eed)
        });
        let dicts = Arc::new(DictStore::new(cfg.state_dir.join("dicts")));
        let engine = Engine {
            dicts,
            inner: Mutex::new(Inner { classes: BTreeMap::new(), rng: ChaCha8Rng::seed_from_u64(seed) }),
            gen_lock: Mutex::new(()),
            save_lock: Mutex::new(()),
            cfg,
        };
        if engine.cfg.persist {
            match state::load(&engine.state_path()) {
                Ok(Some(s)) => engine.restore(s),
                Ok(None) => {}
                Err(e) => eprintln!("[reactor] ignoring unreadable state.json: {}", e),
            }
        }
        engine
    }

    pub fn state_path(&self) -> PathBuf {
        self.cfg.state_dir.join("state.json")
    }

    fn restore(&self, s: PersistedState) {
        let mut inner = lock(&self.inner);
        for (name, pc) in s.classes {
            let Some(class) = classify::canonical(&name) else { continue };
            let c = inner.class(class);
            c.stats = pc.stats;
            if !classify::is_evolvable(class) {
                continue;
            }
            let valid = |r: &Recipe| r.validate().is_ok();
            let pop: Vec<Member> = pc.population.into_iter().filter(|m| valid(&m.recipe)).collect();
            if !pop.is_empty() {
                c.population = pop;
            }
            c.generation = pc.generation;
            c.champion = pc.champion.filter(|ch| valid(&ch.recipe));
            c.pending = pc.pending_immigrants.into_iter().filter(valid).collect();
            c.dicts = pc.dicts;
        }
    }

    pub fn snapshot(&self) -> PersistedState {
        let inner = lock(&self.inner);
        let classes = inner
            .classes
            .iter()
            .map(|(k, c)| {
                (
                    k.to_string(),
                    PersistedClass {
                        generation: c.generation,
                        population: c.population.clone(),
                        champion: c.champion.clone(),
                        pending_immigrants: c.pending.clone(),
                        dicts: c.dicts.clone(),
                        stats: c.stats.clone(),
                    },
                )
            })
            .collect();
        PersistedState { version: state::STATE_VERSION, saved_at_ms: state::now_ms(), classes }
    }

    /// Writes `state.json` atomically (no-op when persistence is disabled).
    pub fn save(&self) -> std::io::Result<()> {
        if !self.cfg.persist {
            return Ok(());
        }
        let snap = self.snapshot();
        let _g = lock(&self.save_lock);
        state::save(&self.state_path(), &snap)
    }

    /// Current recipe for a class: the champion, or the baseline before the first generation.
    pub fn champion_recipe(&self, class: &str) -> Recipe {
        let inner = lock(&self.inner);
        inner
            .classes
            .get(class)
            .and_then(|c| c.champion.as_ref())
            .map(|c| c.recipe.clone())
            .unwrap_or_else(Recipe::baseline)
    }

    pub fn champion(&self, class: &str) -> Option<Champion> {
        lock(&self.inner).classes.get(class).and_then(|c| c.champion.clone())
    }

    pub fn population(&self, class: &str) -> Vec<Member> {
        lock(&self.inner).classes.get(class).map(|c| c.population.clone()).unwrap_or_default()
    }

    pub fn pending_immigrants(&self, class: &str) -> Vec<Recipe> {
        lock(&self.inner).classes.get(class).map(|c| c.pending.clone()).unwrap_or_default()
    }

    pub fn sample_count(&self, class: &str) -> usize {
        lock(&self.inner).classes.get(class).map(|c| c.reservoir.samples.len()).unwrap_or(0)
    }

    /// The current in-memory samples of a class as `(upload index, bytes)`.
    pub fn reservoir(&self, class: &str) -> Vec<(u64, Arc<Vec<u8>>)> {
        lock(&self.inner)
            .classes
            .get(class)
            .map(|c| c.reservoir.samples.iter().map(|s| (s.seq, s.data.clone())).collect())
            .unwrap_or_default()
    }

    /// The held-out part of a class reservoir (what recipes are scored on).
    pub fn held_out(&self, class: &str) -> Vec<Arc<Vec<u8>>> {
        self.reservoir(class).into_iter().filter(|(s, _)| is_held_out(*s)).map(|(_, d)| d).collect()
    }

    pub fn class_dicts(&self, class: &str) -> Vec<String> {
        lock(&self.inner).classes.get(class).map(|c| c.dicts.clone()).unwrap_or_default()
    }

    /// Adds an upload prefix to the class reservoir (reservoir sampling, memory only).
    pub fn observe(&self, class: &'static str, data: &[u8]) {
        if !self.cfg.enabled || !classify::is_evolvable(class) || data.is_empty() {
            return;
        }
        let prefix = &data[..data.len().min(self.cfg.sample_bytes_max)];
        let mut guard = lock(&self.inner);
        let Inner { classes, rng } = &mut *guard;
        let c = classes.entry(class).or_insert_with(|| ClassEvo::new(class));
        let r = &mut c.reservoir;
        let seq = r.seen;
        r.seen += 1;
        c.stats.samples_seen += 1;
        let sample = Sample { seq, data: Arc::new(prefix.to_vec()) };
        if r.samples.len() < RESERVOIR_CAP {
            r.samples.push(sample);
            r.version += 1;
        } else {
            let j = rng.gen_range(0..r.seen);
            if (j as usize) < RESERVOIR_CAP {
                r.samples[j as usize] = sample;
                r.version += 1;
            }
        }
    }

    fn dict_bytes(&self, recipe: &Recipe) -> Option<Arc<Vec<u8>>> {
        recipe.dict_id().and_then(|id| self.dicts.get(&id))
    }

    /// zstd worker threads for compressing `len` bytes with `recipe` on the request path:
    /// > 1 only for zstd recipes above `mt_threshold` (0 = single-threaded).
    pub fn mt_workers_for(&self, recipe: &Recipe, len: usize) -> u32 {
        let c = &self.cfg;
        if recipe.codec == Codec::Zstd && c.mt_threshold > 0 && len > c.mt_threshold && c.mt_workers > 1 {
            c.mt_workers
        } else {
            0
        }
    }

    /// Classify, encode with the class champion (zstd multithreaded for large bodies, see
    /// [`Engine::mt_workers_for`]), verify the round-trip, fall back to legacy raw.
    pub fn compress(&self, data: &[u8], mime_hint: Option<&str>, allow_sample: bool) -> CompressOutcome {
        let entropy = DiocomNativeReactor::calculate_entropy(data);
        let class = classify::classify(data, mime_hint);
        let mut note = None;
        let mut recipe_used = None;
        let mut blob = None;

        if classify::is_evolvable(class) {
            let mut recipe = self.champion_recipe(class);
            let mut dict = None;
            if recipe.dict.is_some() {
                dict = self.dict_bytes(&recipe);
                if dict.is_none() {
                    note = Some("champion dictionary missing; using baseline".to_string());
                    recipe = Recipe::baseline();
                }
            }
            match recipe.encode_with_workers(data, dict.as_deref().map(|d| d.as_slice()), self.mt_workers_for(&recipe, data.len())) {
                Ok(b) => {
                    let lookup = |id: &DictId| if Some(*id) == recipe.dict_id() { dict.clone() } else { None };
                    match codec::decode_v2(&b, usize::MAX, &lookup) {
                        Ok(out) if out.as_slice() == data => {
                            if b.len() < data.len() + 1 {
                                blob = Some(b);
                                recipe_used = Some(recipe);
                            } else {
                                note = Some("v2 not smaller than legacy raw".into());
                            }
                        }
                        Ok(_) => note = Some("round-trip mismatch".into()),
                        Err(e) => note = Some(format!("round-trip failed: {}", e)),
                    }
                }
                Err(e) => note = Some(format!("encode failed: {}", e)),
            }
        } else if class == MEDIA_COMPRESSED {
            note = Some("high-entropy content: raw".into());
        }

        let fell_back = blob.is_none();
        let blob = blob.unwrap_or_else(|| codec::legacy_raw(data));
        {
            let mut inner = lock(&self.inner);
            let c = inner.class(class);
            c.stats.compress_count += 1;
            c.stats.bytes_in += data.len() as u64;
            c.stats.bytes_out += blob.len() as u64;
            if fell_back {
                c.stats.fallback_raw += 1;
            }
        }
        if allow_sample {
            self.observe(class, data);
        }
        CompressOutcome { class, recipe: recipe_used, blob, entropy, note }
    }

    /// Queues validated recipes from a peer as immigrants; returns how many were new.
    pub fn add_immigrants(&self, class: &'static str, recipes: Vec<Recipe>) -> usize {
        if !classify::is_evolvable(class) {
            return 0;
        }
        let mut inner = lock(&self.inner);
        let c = inner.class(class);
        let mut added = 0;
        for r in recipes {
            if r.validate().is_err()
                || c.pending.contains(&r)
                || c.population.iter().any(|m| m.recipe == r)
                || c.pending.len() >= MAX_PENDING_IMMIGRANTS
            {
                continue;
            }
            c.pending.push(r);
            c.stats.immigrants_received += 1;
            added += 1;
        }
        added
    }

    /// Champions offered to peers. Dictionary recipes are only offered when sharing is enabled;
    /// otherwise the best scored non-dictionary recipe of the class is offered instead.
    pub fn gossip_champions(&self, share_dicts: bool) -> Vec<(String, Recipe, f64)> {
        let inner = lock(&self.inner);
        let mut out = Vec::new();
        for (class, c) in &inner.classes {
            let Some(ch) = &c.champion else { continue };
            if ch.recipe.dict.is_none() || share_dicts {
                out.push((class.to_string(), ch.recipe.clone(), ch.score.fitness));
                continue;
            }
            let mut members: Vec<&Member> =
                c.population.iter().filter(|m| m.recipe.dict.is_none() && m.score.is_some()).collect();
            members.sort_by(|a, b| cmp_members(a, b));
            if let Some(m) = members.first() {
                out.push((class.to_string(), m.recipe.clone(), m.score.as_ref().map(|s| s.fitness).unwrap_or(0.0)));
            }
        }
        out
    }

    /// Classes whose reservoir changed (or that have immigrants) and whose interval elapsed.
    pub fn due_classes(&self) -> Vec<&'static str> {
        if !self.cfg.enabled {
            return Vec::new();
        }
        let inner = lock(&self.inner);
        inner
            .classes
            .iter()
            .filter(|(k, c)| {
                classify::is_evolvable(k)
                    && c.dirty()
                    && c.last_run.map(|t| t.elapsed() >= self.cfg.interval).unwrap_or(true)
            })
            .map(|(k, _)| *k)
            .collect()
    }

    fn train_dict(&self, samples: &[Arc<Vec<u8>>]) -> Option<DictId> {
        let total: usize = samples.iter().map(|s| s.len()).sum();
        let max_size = (total / 4).clamp(1024, MAX_DICT_BYTES);
        let refs: Vec<&[u8]> = samples.iter().map(|s| s.as_slice()).collect();
        match zstd::dict::from_samples(&refs, max_size) {
            Ok(d) if !d.is_empty() && d.len() <= MAX_DICT_BYTES => match self.dicts.put(d) {
                Ok(id) => Some(id),
                Err(e) => {
                    eprintln!("[reactor] failed to persist dictionary: {}", e);
                    None
                }
            },
            Ok(_) => None,
            Err(e) => {
                eprintln!("[reactor] dictionary training skipped: {}", e);
                None
            }
        }
    }

    /// Runs one generation for `class` (blocking; call from `spawn_blocking`).
    pub fn run_generation(&self, class: &'static str) -> Option<GenReport> {
        if !classify::is_evolvable(class) {
            return None;
        }
        let _g = lock(&self.gen_lock);

        // 1. Snapshot under the lock. Split the reservoir into train (even upload index) and
        //    held-out (odd). Recipes are scored on held-out samples only; dictionaries are trained
        //    on train samples only, so a dictionary never sees the data it is judged on.
        let (train, score_set, mut candidates, version, need_dict, seen) = {
            let mut inner = lock(&self.inner);
            let c = inner.class(class);
            if c.reservoir.samples.is_empty() {
                return None;
            }
            let samples = c.reservoir.samples.clone();
            let train: Vec<Sample> = samples.iter().filter(|s| !is_held_out(s.seq)).cloned().collect();
            let held: Vec<Sample> = samples.iter().filter(|s| is_held_out(s.seq)).cloned().collect();
            // With no held-out sample yet (a single upload), fall back to samples that no
            // dictionary trained in this process has seen.
            let score_set: Vec<Sample> = if held.is_empty() {
                samples.iter().filter(|s| !c.trained_seqs.contains(&s.seq)).cloned().collect()
            } else {
                held.clone()
            };
            if score_set.is_empty() {
                return None;
            }
            let mut candidates: Vec<Member> = c.population.clone();
            for r in std::mem::take(&mut c.pending) {
                if !candidates.iter().any(|m| m.recipe == r) {
                    candidates.push(Member { recipe: r, score: None, origin: "immigrant".into() });
                }
            }
            let mut sizes: Vec<usize> = samples.iter().map(|s| s.data.len()).collect();
            sizes.sort_unstable();
            let median = sizes[sizes.len() / 2];
            let need_dict = samples.len() >= DICT_MIN_SAMPLES
                && held.len() >= DICT_MIN_HELD_OUT
                && !train.is_empty()
                && median < DICT_MAX_MEDIAN
                && c.dict_trained_at_seen.map(|s| c.reservoir.seen >= s + DICT_RETRAIN_AFTER).unwrap_or(true);
            (train, score_set, candidates, c.reservoir.version, need_dict, c.reservoir.seen)
        };

        // 2. Dictionary training (train split only) + dictionary variants of the top zstd recipes.
        let mut dict_trained = None;
        let mut dict_train_seqs = Vec::new();
        if need_dict {
            let train_data: Vec<Arc<Vec<u8>>> = train.iter().map(|s| s.data.clone()).collect();
            if let Some(id) = self.train_dict(&train_data) {
                dict_train_seqs = train.iter().map(|s| s.seq).collect();
                let mut zstd_members: Vec<&Member> =
                    candidates.iter().filter(|m| m.recipe.codec == Codec::Zstd).collect();
                zstd_members.sort_by(|a, b| cmp_members(a, b));
                let mut variants: Vec<Recipe> =
                    zstd_members.iter().take(2).map(|m| m.recipe.clone().with_dict(Some(&id))).collect();
                variants.push(Recipe::baseline().with_dict(Some(&id)));
                for v in variants {
                    if !candidates.iter().any(|m| m.recipe == v) {
                        candidates.push(Member { recipe: v, score: None, origin: "dict".into() });
                    }
                }
                dict_trained = Some(hex::encode(id));
            }
        }

        // 3. Score every candidate on the same held-out samples (outside the lock).
        let scored_seqs: Vec<u64> = score_set.iter().map(|s| s.seq).collect();
        let score_data: Vec<Arc<Vec<u8>>> = score_set.iter().map(|s| s.data.clone()).collect();
        let mut immigrants_scored = 0;
        for m in candidates.iter_mut() {
            let dict = self.dict_bytes(&m.recipe);
            m.score = score_recipe(&m.recipe, &score_data, dict, self.cfg.w_enc, self.cfg.w_dec, self.cfg.max_output);
            if m.origin == "immigrant" {
                immigrants_scored += 1;
            }
        }
        candidates.sort_by(cmp_members);
        let champion_member = candidates.iter().find(|m| m.score.is_some()).cloned();

        // 4. Selection, crossover, mutation; write back.
        let report = {
            let mut guard = lock(&self.inner);
            let Inner { classes, rng } = &mut *guard;
            let c = classes.entry(class).or_insert_with(|| ClassEvo::new(class));
            if let Some(d) = &dict_trained {
                if !c.dicts.contains(d) {
                    c.dicts.push(d.clone());
                }
                c.dict_trained_at_seen = Some(seen);
                c.stats.dicts_trained += 1;
                c.trained_seqs.extend(dict_train_seqs.iter().copied());
            }
            let latest_dict = c.dicts.last().cloned();
            let mut elites: Vec<Member> = Vec::new();
            for m in candidates.iter().filter(|m| m.score.is_some()) {
                if elites.len() >= ELITE {
                    break;
                }
                if !elites.iter().any(|e| e.recipe == m.recipe) {
                    elites.push(m.clone());
                }
            }
            let mut next = elites.clone();
            if elites.is_empty() {
                next = ClassEvo::new(class).population;
            }
            let mut attempts = 0;
            while next.len() < POPULATION_SIZE && attempts < 1000 && !elites.is_empty() {
                attempts += 1;
                let a = &elites[rng.gen_range(0..elites.len())].recipe;
                let mut child = if elites.len() > 1 && rng.gen_bool(0.6) {
                    let b = &elites[rng.gen_range(0..elites.len())].recipe;
                    crossover(a, b)
                } else {
                    a.clone()
                };
                mutate(&mut child, rng, latest_dict.as_deref());
                if child.validate().is_ok() && !next.iter().any(|m| m.recipe == child) {
                    next.push(Member { recipe: child, score: None, origin: "offspring".into() });
                }
            }
            c.population = next;
            c.generation += 1;
            if let Some(m) = &champion_member {
                c.champion = Some(Champion {
                    recipe: m.recipe.clone(),
                    score: m.score.clone().unwrap_or(Score { fitness: 0.0, ratio: 1.0, enc_mib_s: 0.0, dec_mib_s: 0.0, samples: 0 }),
                    generation: c.generation,
                    origin: m.origin.clone(),
                });
            }
            c.scored_version = version;
            c.last_run = Some(Instant::now());
            c.stats.immigrants_scored += immigrants_scored;
            GenReport {
                class,
                generation: c.generation,
                champion: c.champion.clone(),
                scored: candidates,
                dict_trained,
                dict_train_seqs,
                scored_seqs,
            }
        };
        if let Err(e) = self.save() {
            eprintln!("[reactor] failed to save state: {}", e);
        }
        Some(report)
    }

    /// Per-class status for `/evolution/status`.
    pub fn status(&self) -> Value {
        let inner = lock(&self.inner);
        let mut classes = Vec::new();
        for (k, c) in &inner.classes {
            let champion = c.champion.as_ref().map(|ch| {
                json!({
                    "recipe": ch.recipe,
                    "label": ch.recipe.label(),
                    "fitness": ch.score.fitness,
                    "ratio": ch.score.ratio,
                    "enc_mib_s": ch.score.enc_mib_s,
                    "dec_mib_s": ch.score.dec_mib_s,
                    "generation": ch.generation,
                    "origin": ch.origin,
                })
            });
            classes.push(json!({
                "class": k,
                "evolvable": classify::is_evolvable(k),
                "generation": c.generation,
                "champion": champion,
                "population_size": c.population.len(),
                "samples": c.reservoir.samples.len(),
                "pending_immigrants": c.pending.len(),
                "dicts": c.dicts,
                "stats": c.stats,
            }));
        }
        json!({
            "enabled": self.cfg.enabled,
            "interval_ms": self.cfg.interval.as_millis() as u64,
            "weights": { "encode": self.cfg.w_enc, "decode": self.cfg.w_dec },
            "classes": classes,
        })
    }
}

/// Background scheduler: at most one generation per class per interval, only when dirty.
pub fn spawn_scheduler(
    engine: Arc<Engine>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let tick = engine.cfg.interval.clamp(Duration::from_millis(50), Duration::from_secs(1));
        loop {
            tokio::select! {
                _ = tokio::time::sleep(tick) => {}
                _ = shutdown.changed() => break,
            }
            if *shutdown.borrow() {
                break;
            }
            for class in engine.due_classes() {
                let e = engine.clone();
                if let Err(err) = tokio::task::spawn_blocking(move || e.run_generation(class)).await {
                    eprintln!("[reactor] evolution task failed: {}", err);
                }
            }
        }
    })
}
