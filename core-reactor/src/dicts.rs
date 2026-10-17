//! On-disk zstd dictionary store: `<dir>/<sha256>.dict`, verified on load, never deleted.

use crate::codec::{sha256, DictId};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Dictionaries are at most 110 KiB (spec §3); also the cap for fetching from peers.
pub const MAX_DICT_BYTES: usize = 110 * 1024;

pub struct DictStore {
    dir: PathBuf,
    cache: RwLock<HashMap<DictId, Arc<Vec<u8>>>>,
}

impl DictStore {
    pub fn new(dir: impl Into<PathBuf>) -> DictStore {
        DictStore { dir: dir.into(), cache: RwLock::new(HashMap::new()) }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn path_for(&self, id: &DictId) -> PathBuf {
        self.dir.join(format!("{}.dict", hex::encode(id)))
    }

    /// Returns the dictionary bytes, loading (and SHA-256 verifying) from disk if needed.
    pub fn get(&self, id: &DictId) -> Option<Arc<Vec<u8>>> {
        if let Some(d) = self.cache.read().ok()?.get(id) {
            return Some(d.clone());
        }
        let bytes = std::fs::read(self.path_for(id)).ok()?;
        if sha256(&bytes) != *id {
            eprintln!("[reactor] dictionary {} on disk fails SHA-256 check; ignoring", hex::encode(id));
            return None;
        }
        let arc = Arc::new(bytes);
        if let Ok(mut c) = self.cache.write() {
            c.insert(*id, arc.clone());
        }
        Some(arc)
    }

    pub fn contains(&self, id: &DictId) -> bool {
        self.get(id).is_some()
    }

    /// Persists a dictionary (atomic temp-file + rename) and returns its id.
    pub fn put(&self, bytes: Vec<u8>) -> std::io::Result<DictId> {
        let id = sha256(&bytes);
        let path = self.path_for(&id);
        if !path.exists() {
            std::fs::create_dir_all(&self.dir)?;
            crate::state::atomic_write(&path, &bytes)?;
        }
        if let Ok(mut c) = self.cache.write() {
            c.insert(id, Arc::new(bytes));
        }
        Ok(id)
    }

    /// Stores bytes received from a peer only if they hash to `expected`.
    pub fn put_verified(&self, expected: &DictId, bytes: Vec<u8>) -> Result<(), String> {
        if bytes.len() > MAX_DICT_BYTES {
            return Err(format!("dictionary too large: {} bytes", bytes.len()));
        }
        if sha256(&bytes) != *expected {
            return Err("dictionary SHA-256 mismatch".into());
        }
        self.put(bytes).map(|_| ()).map_err(|e| e.to_string())
    }
}
