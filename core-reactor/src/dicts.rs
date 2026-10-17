//! On-disk zstd dictionary store: `<dir>/<sha256>.dict`, verified on load, never deleted.
//! Dictionaries are trained on user uploads, so with a master key configured each file is an
//! encryption envelope ([`crate::crypto`], kind `Dict`, salt = dictionary id); legacy plaintext
//! files keep loading (verified by SHA-256) and are rewrapped by `reactor-admin rekey`.

use crate::codec::{sha256, DictId};
use crate::crypto::{self, KeyRing, Kind};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

/// Dictionaries are at most 110 KiB (spec §3); also the cap for fetching from peers.
pub const MAX_DICT_BYTES: usize = 110 * 1024;

pub struct DictStore {
    dir: PathBuf,
    cache: RwLock<HashMap<DictId, Arc<Vec<u8>>>>,
    keys: Arc<KeyRing>,
}

impl DictStore {
    pub fn new(dir: impl Into<PathBuf>) -> DictStore {
        DictStore::with_keys(dir, Arc::new(KeyRing::disabled()))
    }

    pub fn with_keys(dir: impl Into<PathBuf>, keys: Arc<KeyRing>) -> DictStore {
        DictStore { dir: dir.into(), cache: RwLock::new(HashMap::new()), keys }
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
        let stored = std::fs::read(self.path_for(id)).ok()?;
        let bytes = match self.keys.open(Kind::Dict, id, &stored) {
            Ok(b) => b.into_owned(),
            Err(e) => {
                eprintln!("[reactor] dictionary {}: {}", hex::encode(id), e);
                return None;
            }
        };
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
            crate::state::atomic_write(&path, &self.keys.seal(Kind::Dict, &id, bytes.clone()))?;
        }
        if let Ok(mut c) = self.cache.write() {
            c.insert(id, Arc::new(bytes));
        }
        Ok(id)
    }

    /// Ids of the dictionary files on disk.
    pub fn list_ids(&self) -> Vec<DictId> {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return Vec::new() };
        rd.flatten()
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let h = name.strip_suffix(".dict")?;
                hex::decode(h).ok()?.try_into().ok()
            })
            .collect()
    }

    /// Rewraps a dictionary file under the active key when it is plaintext or sealed under another
    /// key (atomic replace). Returns whether it was rewritten.
    pub fn rekey(&self, id: &DictId) -> Result<bool, String> {
        let path = self.path_for(id);
        let stored = std::fs::read(&path).map_err(|e| e.to_string())?;
        let Some(active) = self.keys.active_id() else { return Ok(false) };
        if crypto::sealed_key_id(&stored) == Some(active) {
            return Ok(false);
        }
        let plain = self.keys.open(Kind::Dict, id, &stored).map_err(|e| e.to_string())?.into_owned();
        if sha256(&plain) != *id {
            return Err(format!("dictionary {} fails SHA-256 check", hex::encode(id)));
        }
        crate::state::atomic_write(&path, &self.keys.seal(Kind::Dict, id, plain)).map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Key id a dictionary file is sealed under (`None` = plaintext or unreadable).
    pub fn file_key_id(&self, id: &DictId) -> Option<String> {
        let b = std::fs::read(self.path_for(id)).ok()?;
        crypto::sealed_key_id(&b).map(|s| s.to_string())
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
