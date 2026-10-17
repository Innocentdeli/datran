//! Encryption at rest (NETWORK_SPEC §7).
//!
//! Master keys come from the environment (`REACTOR_MASTER_KEY`, `REACTOR_MASTER_KEY_FILE`,
//! `REACTOR_MASTER_KEYS` + `REACTOR_ACTIVE_KEY_ID`). Every stored object / dictionary is sealed
//! with AES-256-GCM-SIV (RFC 8452, nonce-misuse resistant; AES-NI / CLMUL when available) under a
//! per-item key `HKDF-SHA256(ikm = master, salt = item id, info = "datran-obj-v1" |
//! "datran-dict-v1")` and a random 96-bit nonce. Envelope:
//!
//! ```text
//! magic "DTE1" (4) | kind u8 (1 object, 2 dict) | key_id_len u8 | key_id | nonce [12] | ciphertext ‖ tag [16]
//! AAD = everything before the nonce ‖ item id [32]
//! ```
//!
//! The AAD binds format version (magic), kind, key id and item id, so an envelope cannot be
//! moved to another id or relabelled with another key id. Blob-v2 objects start with `0x10` and
//! never with `D`, so legacy plaintext objects are recognised unambiguously.

use aes_gcm_siv::aead::AeadInOut;
use aes_gcm_siv::{Aes256GcmSiv, KeyInit, Nonce, Tag};
use hkdf::Hkdf;
use rand::RngCore;
use sha2::Sha256;
use std::borrow::Cow;
use zeroize::Zeroizing;

pub const MAGIC: &[u8; 4] = b"DTE1";
pub const NONCE_LEN: usize = 12;
/// Name reported in stats.
pub const ALGORITHM: &str = "AES-256-GCM-SIV, per-object key HKDF-SHA256(master, salt=id)";
pub const TAG_LEN: usize = 16;
pub const MAX_KEY_ID: usize = 32;
/// Key id used for `REACTOR_MASTER_KEY` / `REACTOR_MASTER_KEY_FILE` when no id is given.
pub const DEFAULT_KEY_ID: &str = "default";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Object = 1,
    Dict = 2,
}

impl Kind {
    fn info(self) -> &'static [u8] {
        match self {
            Kind::Object => b"datran-obj-v1",
            Kind::Dict => b"datran-dict-v1",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CryptoError {
    /// The envelope names a key id this node is not configured with.
    MissingKey(String),
    /// Tag check failed (tampered, wrong id, wrong key material).
    Auth(String),
    /// Not a well-formed envelope.
    Malformed(String),
}

impl std::fmt::Display for CryptoError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CryptoError::MissingKey(id) => write!(f, "encryption key {:?} is not configured (set it in REACTOR_MASTER_KEYS)", id),
            CryptoError::Auth(m) => write!(f, "decryption failed: {}", m),
            CryptoError::Malformed(m) => write!(f, "malformed encrypted envelope: {}", m),
        }
    }
}

impl std::error::Error for CryptoError {}

/// Whether `b` is an encryption envelope (vs. a legacy plaintext item).
pub fn is_sealed(b: &[u8]) -> bool {
    b.len() >= 4 && &b[..4] == MAGIC
}

/// Key id of an envelope (`None` for plaintext / malformed headers).
pub fn sealed_key_id(b: &[u8]) -> Option<&str> {
    if !is_sealed(b) || b.len() < 6 {
        return None;
    }
    let n = b[5] as usize;
    std::str::from_utf8(b.get(6..6 + n)?).ok()
}

/// Bytes needed to parse an envelope header (enough for [`sealed_key_id`]).
pub const HEADER_PEEK: usize = 6 + MAX_KEY_ID;

fn valid_key_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_KEY_ID && id.bytes().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
}

/// Configured master keys (zeroized on drop) and the active one.
pub struct KeyRing {
    keys: Vec<(String, Zeroizing<[u8; 32]>)>,
    active: Option<usize>,
}

impl std::fmt::Debug for KeyRing {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyRing").field("key_ids", &self.key_ids()).field("active", &self.active_id()).finish()
    }
}

impl Default for KeyRing {
    fn default() -> Self {
        KeyRing::disabled()
    }
}

impl KeyRing {
    /// No keys: items are stored in plaintext (development only).
    pub fn disabled() -> KeyRing {
        KeyRing { keys: Vec::new(), active: None }
    }

    /// Keys `(id, master)`; new writes use `active`.
    pub fn new(keys: Vec<(String, [u8; 32])>, active: &str) -> Result<KeyRing, String> {
        let mut out: Vec<(String, Zeroizing<[u8; 32]>)> = Vec::new();
        for (id, k) in keys {
            if !valid_key_id(&id) {
                return Err(format!("invalid key id {:?} (1-{} chars of [A-Za-z0-9._-])", id, MAX_KEY_ID));
            }
            if out.iter().any(|(i, _)| *i == id) {
                return Err(format!("key id {:?} configured twice", id));
            }
            out.push((id, Zeroizing::new(k)));
        }
        let active = out.iter().position(|(i, _)| i == active).ok_or_else(|| format!("active key id {:?} is not among the configured keys", active))?;
        Ok(KeyRing { keys: out, active: Some(active) })
    }

    /// One key with id `id`.
    pub fn single(id: &str, key: [u8; 32]) -> KeyRing {
        KeyRing::new(vec![(id.to_string(), key)], id).expect("valid single key")
    }

    /// Reads the `REACTOR_MASTER_KEY*` variables (see module docs). No variable set → disabled.
    pub fn from_env() -> Result<KeyRing, String> {
        KeyRing::from_lookup(|k| std::env::var(k).ok().filter(|v| !v.trim().is_empty()))
    }

    /// [`KeyRing::from_env`] with an injectable variable lookup.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<KeyRing, String> {
        let active_env = get("REACTOR_ACTIVE_KEY_ID").map(|s| s.trim().to_string());
        let mut keys: Vec<(String, [u8; 32])> = Vec::new();
        if let Some(list) = get("REACTOR_MASTER_KEYS") {
            keys.extend(parse_key_list(&list).map_err(|e| format!("REACTOR_MASTER_KEYS: {}", e))?);
        }
        let single_id = active_env.clone().filter(|_| keys.is_empty()).unwrap_or_else(|| DEFAULT_KEY_ID.to_string());
        if let Some(k) = get("REACTOR_MASTER_KEY") {
            keys.push((single_id.clone(), parse_key(k.trim()).map_err(|e| format!("REACTOR_MASTER_KEY: {}", e))?));
        }
        if let Some(path) = get("REACTOR_MASTER_KEY_FILE") {
            let text = Zeroizing::new(std::fs::read_to_string(path.trim()).map_err(|e| format!("REACTOR_MASTER_KEY_FILE {}: {}", path.trim(), e))?);
            let t = text.trim();
            if t.contains(':') {
                keys.extend(parse_key_list(t).map_err(|e| format!("REACTOR_MASTER_KEY_FILE: {}", e))?);
            } else {
                keys.push((single_id, parse_key(t).map_err(|e| format!("REACTOR_MASTER_KEY_FILE: {}", e))?));
            }
        }
        if keys.is_empty() {
            if active_env.is_some() {
                return Err("REACTOR_ACTIVE_KEY_ID is set but no master key is configured".into());
            }
            return Ok(KeyRing::disabled());
        }
        let active = match active_env {
            Some(a) => a,
            None if keys.len() == 1 => keys[0].0.clone(),
            None => return Err("several master keys configured: set REACTOR_ACTIVE_KEY_ID".into()),
        };
        let r = KeyRing::new(keys.clone(), &active);
        for k in keys.iter_mut() {
            zeroize::Zeroize::zeroize(&mut k.1);
        }
        r
    }

    pub fn enabled(&self) -> bool {
        self.active.is_some()
    }

    pub fn active_id(&self) -> Option<&str> {
        self.active.map(|i| self.keys[i].0.as_str())
    }

    pub fn key_ids(&self) -> Vec<String> {
        self.keys.iter().map(|k| k.0.clone()).collect()
    }

    pub fn has_key(&self, id: &str) -> bool {
        self.keys.iter().any(|k| k.0 == id)
    }

    fn cipher(master: &[u8; 32], kind: Kind, id: &[u8; 32]) -> Aes256GcmSiv {
        let hk = Hkdf::<Sha256>::new(Some(id), master);
        let mut okm = Zeroizing::new([0u8; 32]);
        hk.expand(kind.info(), okm.as_mut()).expect("32 bytes is a valid HKDF-SHA256 length");
        Aes256GcmSiv::new_from_slice(okm.as_ref()).expect("32-byte key")
    }

    /// Seals `plain` under the active key; returns it unchanged when encryption is disabled.
    pub fn seal(&self, kind: Kind, id: &[u8; 32], plain: Vec<u8>) -> Vec<u8> {
        let Some(a) = self.active else { return plain };
        let (kid, master) = (&self.keys[a].0, &self.keys[a].1);
        let hdr = 6 + kid.len();
        let mut out = Vec::with_capacity(hdr + NONCE_LEN + plain.len() + TAG_LEN);
        out.extend_from_slice(MAGIC);
        out.push(kind as u8);
        out.push(kid.len() as u8);
        out.extend_from_slice(kid.as_bytes());
        let mut nonce = [0u8; NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        out.extend_from_slice(&nonce);
        let mut aad = Vec::with_capacity(hdr + 32);
        aad.extend_from_slice(&out[..hdr]);
        aad.extend_from_slice(id);
        let body = out.len();
        out.extend_from_slice(&plain);
        drop(plain);
        let n = Nonce::try_from(&nonce[..]).expect("12-byte nonce");
        let tag = Self::cipher(master, kind, id)
            .encrypt_inout_detached(&n, &aad, out[body..].as_mut().into())
            .expect("AES-GCM-SIV accepts objects up to 64 GiB");
        out.extend_from_slice(tag.as_slice());
        out
    }

    /// Opens an envelope for item `id`; a plaintext (legacy) item is returned as is. A sealed
    /// item whose key id is not configured is an error — never treated as plaintext.
    pub fn open<'a>(&self, kind: Kind, id: &[u8; 32], stored: &'a [u8]) -> Result<Cow<'a, [u8]>, CryptoError> {
        if !is_sealed(stored) {
            return Ok(Cow::Borrowed(stored));
        }
        if stored.len() < 6 {
            return Err(CryptoError::Malformed("truncated header".into()));
        }
        if stored[4] != kind as u8 {
            return Err(CryptoError::Malformed(format!("envelope kind {} where {} expected", stored[4], kind as u8)));
        }
        let kid_len = stored[5] as usize;
        let hdr = 6 + kid_len;
        if kid_len == 0 || kid_len > MAX_KEY_ID || stored.len() < hdr + NONCE_LEN + TAG_LEN {
            return Err(CryptoError::Malformed("truncated or invalid header".into()));
        }
        let kid = std::str::from_utf8(&stored[6..hdr]).map_err(|_| CryptoError::Malformed("key id is not UTF-8".into()))?;
        let master = &self.keys.iter().find(|k| k.0 == kid).ok_or_else(|| CryptoError::MissingKey(kid.to_string()))?.1;
        let nonce = Nonce::try_from(&stored[hdr..hdr + NONCE_LEN]).map_err(|_| CryptoError::Malformed("nonce".into()))?;
        let ct_end = stored.len() - TAG_LEN;
        let tag = Tag::try_from(&stored[ct_end..]).map_err(|_| CryptoError::Malformed("tag".into()))?;
        let mut aad = Vec::with_capacity(hdr + 32);
        aad.extend_from_slice(&stored[..hdr]);
        aad.extend_from_slice(id);
        let mut buf = stored[hdr + NONCE_LEN..ct_end].to_vec();
        Self::cipher(master, kind, id)
            .decrypt_inout_detached(&nonce, &aad, buf.as_mut_slice().into(), &tag)
            .map_err(|_| CryptoError::Auth(format!("authentication tag mismatch (key {:?})", kid)))?;
        Ok(Cow::Owned(buf))
    }
}

/// `REACTOR_REQUIRE_ENCRYPTION=true`.
pub fn require_encryption_from_env() -> bool {
    std::env::var("REACTOR_REQUIRE_ENCRYPTION").map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on")).unwrap_or(false)
}

/// Loads the key ring for a process: errors on bad configuration, refuses to run without a key
/// when `REACTOR_REQUIRE_ENCRYPTION` is set, and warns loudly when running unencrypted.
pub fn keyring_for_startup() -> Result<KeyRing, String> {
    let ring = KeyRing::from_env()?;
    if !ring.enabled() {
        if require_encryption_from_env() {
            return Err("REACTOR_REQUIRE_ENCRYPTION is set but no master key is configured (REACTOR_MASTER_KEY, REACTOR_MASTER_KEY_FILE or REACTOR_MASTER_KEYS)".into());
        }
        eprintln!("[reactor] ************************************************************************");
        eprintln!("[reactor] WARNING: encryption at rest is DISABLED (no REACTOR_MASTER_KEY configured).");
        eprintln!("[reactor] Stored objects and dictionaries are written in plaintext. Development only;");
        eprintln!("[reactor] set REACTOR_REQUIRE_ENCRYPTION=true in production to refuse this.");
        eprintln!("[reactor] ************************************************************************");
    }
    Ok(ring)
}

/// `id:key` entries separated by commas, whitespace or newlines.
fn parse_key_list(s: &str) -> Result<Vec<(String, [u8; 32])>, String> {
    let mut out = Vec::new();
    for item in s.split(|c: char| c == ',' || c.is_whitespace()).filter(|t| !t.is_empty()) {
        let (id, key) = item.split_once(':').ok_or_else(|| format!("entry {:?} is not id:key", item.split(':').next().unwrap_or("")))?;
        let id = id.trim();
        if !valid_key_id(id) {
            return Err(format!("invalid key id {:?}", id));
        }
        out.push((id.to_string(), parse_key(key.trim()).map_err(|e| format!("key {:?}: {}", id, e))?));
    }
    if out.is_empty() {
        return Err("no keys".into());
    }
    Ok(out)
}

/// 32 bytes as 64 hex digits or base64 (standard / URL-safe, padding optional).
pub fn parse_key(s: &str) -> Result<[u8; 32], String> {
    let s = s.trim();
    if s.len() == 64 && s.bytes().all(|c| c.is_ascii_hexdigit()) {
        let v = Zeroizing::new(hex::decode(s).map_err(|e| e.to_string())?);
        let mut k = [0u8; 32];
        k.copy_from_slice(&v);
        return Ok(k);
    }
    let v = Zeroizing::new(base64_decode(s).ok_or("key is neither 64 hex digits nor base64")?);
    if v.len() != 32 {
        return Err(format!("key must be 32 bytes, got {}", v.len()));
    }
    let mut k = [0u8; 32];
    k.copy_from_slice(&v);
    Ok(k)
}

fn base64_decode(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0u32);
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            _ => return None,
        } as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    if bits >= 6 {
        return None;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_open_roundtrip_and_binding() {
        let r = KeyRing::single("k1", [7u8; 32]);
        let id = [1u8; 32];
        let s = r.seal(Kind::Object, &id, b"hello world".to_vec());
        assert!(is_sealed(&s));
        assert_eq!(sealed_key_id(&s), Some("k1"));
        assert_eq!(r.open(Kind::Object, &id, &s).unwrap().as_ref(), b"hello world");
        // other id / other kind rejected
        assert!(matches!(r.open(Kind::Object, &[2u8; 32], &s), Err(CryptoError::Auth(_))));
        assert!(matches!(r.open(Kind::Dict, &id, &s), Err(CryptoError::Malformed(_))));
        // tamper
        let mut t = s.clone();
        let n = t.len();
        t[n - 20] ^= 1;
        assert!(matches!(r.open(Kind::Object, &id, &t), Err(CryptoError::Auth(_))));
        // relabelled key id
        let r2 = KeyRing::new(vec![("k1".into(), [7u8; 32]), ("k2".into(), [7u8; 32])], "k1").unwrap();
        let mut t = s.clone();
        t[7] = b'2';
        assert!(matches!(r2.open(Kind::Object, &id, &t), Err(CryptoError::Auth(_))));
        // missing key
        let r3 = KeyRing::single("k9", [7u8; 32]);
        assert_eq!(r3.open(Kind::Object, &id, &s), Err(CryptoError::MissingKey("k1".into())));
        // plaintext passes through; disabled ring seals nothing
        assert_eq!(r.open(Kind::Object, &id, b"\x10abc").unwrap().as_ref(), b"\x10abc");
        assert_eq!(KeyRing::disabled().seal(Kind::Object, &id, b"x".to_vec()), b"x");
        // a disabled ring cannot open sealed data
        assert!(matches!(KeyRing::disabled().open(Kind::Object, &id, &s), Err(CryptoError::MissingKey(_))));
    }

    /// `cargo test --release --lib crypto::tests::throughput -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn throughput() {
        let r = KeyRing::single("k1", [7u8; 32]);
        let data = vec![0x5au8; 64 * 1024];
        let n = 4096; // 256 MiB
        let t = std::time::Instant::now();
        let mut sealed = Vec::new();
        for i in 0..n {
            let mut id = [0u8; 32];
            id[..8].copy_from_slice(&(i as u64).to_le_bytes());
            sealed = r.seal(Kind::Object, &id, data.clone());
        }
        let s = t.elapsed().as_secs_f64();
        let t = std::time::Instant::now();
        let mut id = [0u8; 32];
        id[..8].copy_from_slice(&((n - 1) as u64).to_le_bytes());
        for _ in 0..n {
            assert_eq!(r.open(Kind::Object, &id, &sealed).unwrap().len(), data.len());
        }
        let o = t.elapsed().as_secs_f64();
        println!("seal {:.0} MiB/s, open {:.0} MiB/s (64 KiB objects, one core)", 256.0 / s, 256.0 / o);
    }

    #[test]
    fn env_parsing() {
        let hex = "00".repeat(31) + "01";
        let b64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=";
        assert_eq!(parse_key(&hex).unwrap(), parse_key(b64).unwrap());
        assert_eq!(parse_key(b64.trim_end_matches('=')).unwrap()[31], 1);
        assert!(parse_key("abc").is_err());
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|p| p.0 == k).map(|p| p.1.to_string());
        assert!(!KeyRing::from_lookup(env(&[])).unwrap().enabled());
        let r = KeyRing::from_lookup(env(&[("REACTOR_MASTER_KEY", "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=")])).unwrap();
        assert_eq!(r.active_id(), Some(DEFAULT_KEY_ID));
        let list = "a:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE=,b:0000000000000000000000000000000000000000000000000000000000000002";
        assert!(KeyRing::from_lookup(move |k: &str| (k == "REACTOR_MASTER_KEYS").then(|| list.to_string())).is_err());
        let r = KeyRing::from_lookup(move |k: &str| match k {
            "REACTOR_MASTER_KEYS" => Some(list.to_string()),
            "REACTOR_ACTIVE_KEY_ID" => Some("b".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(r.active_id(), Some("b"));
        assert_eq!(r.key_ids(), vec!["a".to_string(), "b".to_string()]);
        assert!(KeyRing::from_lookup(env(&[("REACTOR_ACTIVE_KEY_ID", "x")])).is_err());
    }
}
