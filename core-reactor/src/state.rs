//! Persistence of evolution state (`$REACTOR_STATE_DIR/state.json`). Samples are never persisted.

use crate::recipe::Recipe;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;

pub const STATE_VERSION: u32 = 1;

/// Measured score of a recipe on a class reservoir. Recipes that failed verification have no score.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Score {
    pub fitness: f64,
    /// Geometric mean of original/compressed over the scored samples.
    pub ratio: f64,
    pub enc_mib_s: f64,
    pub dec_mib_s: f64,
    pub samples: usize,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Member {
    pub recipe: Recipe,
    #[serde(default)]
    pub score: Option<Score>,
    /// "seed", "offspring", "immigrant", "dict"
    #[serde(default)]
    pub origin: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Champion {
    pub recipe: Recipe,
    pub score: Score,
    pub generation: u64,
    #[serde(default)]
    pub origin: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct ClassStats {
    pub compress_count: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub fallback_raw: u64,
    pub samples_seen: u64,
    pub immigrants_received: u64,
    pub immigrants_scored: u64,
    pub dicts_trained: u64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PersistedClass {
    pub generation: u64,
    pub population: Vec<Member>,
    pub champion: Option<Champion>,
    #[serde(default)]
    pub pending_immigrants: Vec<Recipe>,
    #[serde(default)]
    pub dicts: Vec<String>,
    #[serde(default)]
    pub stats: ClassStats,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PersistedState {
    pub version: u32,
    pub saved_at_ms: u64,
    pub classes: BTreeMap<String, PersistedClass>,
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Write `bytes` to `path` atomically: write a sibling temp file, fsync, rename over the target.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(dir)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{}.{}.tmp", file_name, std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&tmp);
    })
}

pub fn save(path: &Path, state: &PersistedState) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    atomic_write(path, &json)
}

/// Loads state; a missing file yields `Ok(None)`, a corrupt one an error.
pub fn load(path: &Path) -> Result<Option<PersistedState>, String> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let state: PersistedState = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if state.version != STATE_VERSION {
        return Err(format!("unsupported state version {}", state.version));
    }
    Ok(Some(state))
}
