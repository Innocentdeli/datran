//! Encryption at rest (NETWORK_SPEC §7): sealed objects (file + pack layout), dictionaries,
//! id binding, key rotation + rekey (library and `reactor-admin`), missing keys, legacy plaintext
//! stores, crash safety of rekey and `REACTOR_REQUIRE_ENCRYPTION`.

mod common;

use common::*;
use core_reactor::classify::TEXT_JSON;
use core_reactor::crypto::{self, KeyRing};
use core_reactor::evolution::Engine;
use core_reactor::store::{sha256, Id, PutOptions, Store, StoreConfig, StoreError};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

const MARKER: &[u8] = b"SECRET-MARKER-7f3a9c";
const K1: [u8; 32] = [0x11; 32];
const K2: [u8; 32] = [0x22; 32];

fn ring(keys: &[(&str, [u8; 32])], active: &str) -> KeyRing {
    KeyRing::new(
        keys.iter().map(|(i, k)| (i.to_string(), *k)).collect(),
        active,
    )
    .unwrap()
}

/// Opens engine + store under `dir` (state dir layout: `dicts/`, `store/`).
fn open(dir: &Path, keys: KeyRing, pack_threshold: Option<usize>) -> Store {
    let mut ec = test_config(dir, 5);
    ec.persist = false;
    ec.keys = Arc::new(keys);
    let engine = Arc::new(Engine::new(ec));
    let mut sc = StoreConfig::new(dir.join("store"));
    sc.gc_grace = Duration::from_millis(0);
    sc.fusion = false;
    if let Some(t) = pack_threshold {
        sc.pack_threshold = t;
    }
    Store::open(sc, engine).unwrap()
}

/// Text with the marker sprinkled in, `n` bytes.
fn secret_text(n: usize, seed: u64) -> Vec<u8> {
    let mut out = Vec::with_capacity(n + 64);
    let base = text(n, seed);
    for (i, c) in base.chunks(4000).enumerate() {
        out.extend_from_slice(c);
        out.extend_from_slice(MARKER);
        out.extend_from_slice(format!(" #{} ", i).as_bytes());
    }
    out.truncate(n);
    out
}

/// Random (incompressible) data with markers: stored objects are ≥ the pack threshold (files).
fn secret_random(n: usize, seed: u64) -> Vec<u8> {
    let mut d = random_bytes(n, seed);
    for at in (0..n.saturating_sub(MARKER.len())).step_by(10_000) {
        d[at..at + MARKER.len()].copy_from_slice(MARKER);
    }
    d
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

/// Every file under `dir` whose raw bytes contain `needle`.
fn files_containing(dir: &Path, needle: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if std::fs::read(&p)
                .map(|b| contains(&b, needle))
                .unwrap_or(false)
            {
                out.push(p.display().to_string());
            }
        }
    }
    out
}

fn put(store: &Store, data: &[u8]) -> Id {
    store
        .put_bytes(
            data,
            &PutOptions {
                content_type: None,
                sample: false,
            },
        )
        .unwrap()
        .file_id
}

fn enc_stats(store: &Store) -> serde_json::Value {
    store.stats().unwrap()["encryption"].clone()
}

#[test]
fn encrypted_roundtrip_files_and_packs_ranges_and_no_plaintext_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    // 32 KiB threshold: compressed text chunks are packed, random chunks become files
    let store = open(dir.path(), KeyRing::single("k1", K1), Some(32 * 1024));
    let small = secret_text(900_000, 1); // compressible -> packed objects
    let large = secret_random(1_200_000, 2); // incompressible -> file objects
    let (fs, fl) = (put(&store, &small), put(&store, &large));
    assert_eq!(store.read_to_vec(&fs, None).unwrap(), small);
    assert_eq!(store.read_to_vec(&fl, None).unwrap(), large);
    for (fid, data) in [(fs, &small), (fl, &large)] {
        for (s, e) in [
            (0u64, 1u64),
            (70_000, 333_333),
            (data.len() as u64 - 10, data.len() as u64),
        ] {
            assert_eq!(
                store.read_to_vec(&fid, Some((s, e))).unwrap(),
                &data[s as usize..e as usize]
            );
        }
    }
    let st = store.stats().unwrap();
    assert!(
        st["packs"]["packed_objects"].as_u64().unwrap() > 0,
        "some objects are packed"
    );
    assert!(
        st["packs"]["packed_objects"].as_u64().unwrap() < st["objects"].as_u64().unwrap(),
        "some are files"
    );
    let enc = &st["encryption"];
    assert_eq!(enc["enabled"], true);
    assert_eq!(enc["active_key_id"], "k1");
    assert_eq!(enc["objects_by_key"]["k1"], st["objects"]);
    assert_eq!(enc["plaintext_objects"], 0);
    // object ids are still SHA-256 of the plaintext; the envelope is bound to them
    let refs = store.chunk_refs(&fl).unwrap().unwrap().1;
    let at = store.object_storage(&refs[0].object_id).unwrap().unwrap();
    let raw = std::fs::read(&at.path).unwrap();
    let stored = &raw[at.offset as usize..(at.offset + at.len) as usize];
    assert_eq!(crypto::sealed_key_id(stored), Some("k1"));
    assert_eq!(refs[0].object_id, sha256(&large[..refs[0].len as usize]));
    // nothing on disk contains the plaintext marker
    assert_eq!(files_containing(dir.path(), MARKER), Vec::<String>::new());
    assert!(store.verify_index(true).unwrap().ok());
    let rep = store.scrub_step(u64::MAX).unwrap();
    assert!(rep.corrupt.is_empty() && rep.unverifiable == 0);
}

#[test]
fn packs_and_compaction_stay_encrypted() {
    let dir = tempfile::tempdir().unwrap();
    let mut ec = test_config(dir.path(), 5);
    ec.persist = false;
    ec.keys = Arc::new(KeyRing::single("k1", K1));
    let engine = Arc::new(Engine::new(ec));
    let mut sc = StoreConfig::new(dir.path().join("store"));
    sc.gc_grace = Duration::from_millis(0);
    sc.fusion = false;
    sc.pack_max_bytes = 96 * 1024; // many small sealed packs
    let store = Store::open(sc, engine).unwrap();
    let docs: Vec<Vec<u8>> = (0..12).map(|i| secret_text(300_000, 100 + i)).collect();
    let ids: Vec<Id> = docs.iter().map(|d| put(&store, d)).collect();
    assert!(
        store.stats().unwrap()["packs"]["sealed_packs"]
            .as_u64()
            .unwrap()
            >= 2
    );
    for id in ids.iter().step_by(2).take(5) {
        store.delete(id).unwrap();
    }
    // GC compacts sealed packs right after collecting (live records are copied, still sealed)
    let g = store.gc().unwrap();
    assert!(
        g.packs_compacted > 0
            && store.stats().unwrap()["packs"]["compaction_moved_objects"]
                .as_u64()
                .unwrap()
                > 0,
        "{:?}",
        g
    );
    store.compact_packs_with(1.0, 0).unwrap();
    for (i, (id, d)) in ids.iter().zip(&docs).enumerate() {
        if i % 2 == 1 || i >= 10 {
            assert_eq!(&store.read_to_vec(id, None).unwrap(), d);
        }
    }
    assert!(store.verify_index(true).unwrap().ok());
    assert_eq!(files_containing(dir.path(), MARKER), Vec::<String>::new());
    let enc = enc_stats(&store);
    assert_eq!(enc["plaintext_objects"], 0);
}

#[test]
fn dictionaries_and_state_are_encrypted_on_disk() {
    let dir = tempfile::tempdir().unwrap();
    let mut c = test_config(dir.path(), 9);
    c.w_enc = 0.0;
    c.w_dec = 0.0;
    c.keys = Arc::new(KeyRing::single("k1", K1));
    let engine = Arc::new(Engine::new(c));
    let docs: Vec<Vec<u8>> = (0..40)
        .map(|i| {
            let mut d = format!(
                "{{\"owner\":\"{}\",\"seq\":{},\"rows\":",
                String::from_utf8_lossy(MARKER),
                i
            )
            .into_bytes();
            d.extend_from_slice(&small_json(1000 + i));
            d.push(b'}');
            d
        })
        .collect();
    for d in &docs {
        engine.compress(d, Some("application/json"), true);
    }
    let r = engine.run_generation(TEXT_JSON).unwrap();
    let id = r.dict_trained.expect("dictionary trained");
    let did: [u8; 32] = hex::decode(&id).unwrap().try_into().unwrap();
    let dict = engine
        .dicts
        .get(&did)
        .expect("dictionary loads (decrypted)");
    assert!(
        contains(&dict, MARKER),
        "the training data's marker is in the plaintext dictionary"
    );
    let file = std::fs::read(engine.dicts.path_for(&did)).unwrap();
    assert_eq!(crypto::sealed_key_id(&file), Some("k1"));
    engine.save().unwrap();
    // store objects too (sampled uploads), then grep every byte under the state dir
    let mut sc = StoreConfig::new(dir.path().join("store"));
    sc.fusion = false;
    let store = Store::open(sc, engine.clone()).unwrap();
    for d in docs.iter().take(10) {
        store
            .put_bytes(
                d,
                &PutOptions {
                    content_type: Some("application/json".into()),
                    sample: true,
                },
            )
            .unwrap();
    }
    assert_eq!(files_containing(dir.path(), MARKER), Vec::<String>::new());
    let state = std::fs::read_to_string(dir.path().join("state.json")).unwrap();
    assert!(
        state.contains("\"population\"") && !state.contains("SECRET"),
        "state.json only holds recipes / scores / dict ids"
    );
    let enc = enc_stats(&store);
    assert_eq!(enc["dictionaries"]["by_key"]["k1"], 1);
    assert_eq!(enc["dictionaries"]["plaintext"], 0);

    // a fresh engine with the same key reads the dictionary; without the key it is unavailable
    let mut c2 = test_config(dir.path(), 9);
    c2.keys = Arc::new(KeyRing::single("k1", K1));
    assert!(Engine::new(c2).dicts.get(&did).is_some());
    let mut c3 = test_config(dir.path(), 9);
    c3.keys = Arc::new(KeyRing::single("other", K2));
    assert!(
        Engine::new(c3).dicts.get(&did).is_none(),
        "wrong key: never treated as plaintext"
    );
}

#[test]
fn swapped_or_tampered_objects_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let store = open(dir.path(), KeyRing::single("k1", K1), Some(0)); // every object is a file
    let a = secret_random(300_000, 3);
    let b = secret_random(300_000, 4);
    let (fa, fb) = (put(&store, &a), put(&store, &b));
    let oa = store.chunk_refs(&fa).unwrap().unwrap().1[0].object_id;
    let ob = store.chunk_refs(&fb).unwrap().unwrap().1[0].object_id;
    let (pa, pb) = (
        store.object_storage(&oa).unwrap().unwrap().path,
        store.object_storage(&ob).unwrap().unwrap().path,
    );
    let (ba, bb) = (std::fs::read(&pa).unwrap(), std::fs::read(&pb).unwrap());
    // swap the two sealed files between ids: the AAD binds each envelope to its id
    std::fs::write(&pa, &bb).unwrap();
    std::fs::write(&pb, &ba).unwrap();
    match store.read_to_vec(&fa, None) {
        Err(StoreError::Corrupt(m)) => assert!(m.contains("decryption failed"), "{}", m),
        other => panic!(
            "swapped object must be rejected, got {:?}",
            other.map(|v| v.len())
        ),
    }
    assert!(store.read_to_vec(&fb, None).is_err());
    let q: Vec<Id> = store
        .quarantined()
        .unwrap()
        .into_iter()
        .map(|q| q.0)
        .collect();
    assert!(q.contains(&oa) && q.contains(&ob));
    // an envelope relabelled with another key id fails too (key id is in the AAD)
    let c = secret_random(300_000, 5);
    let fc = put(&store, &c);
    let oc = store.chunk_refs(&fc).unwrap().unwrap().1[0].object_id;
    let pc = store.object_storage(&oc).unwrap().unwrap().path;
    let mut bc = std::fs::read(&pc).unwrap();
    assert_eq!(&bc[6..8], b"k1");
    bc[7] = b'2';
    std::fs::write(&pc, &bc).unwrap();
    assert!(store.read_to_vec(&fc, None).is_err());
}

#[test]
fn key_rotation_rekey_then_old_key_removed() {
    let dir = tempfile::tempdir().unwrap();
    let datas: Vec<Vec<u8>> = vec![secret_text(800_000, 7), secret_random(700_000, 8)];
    let ids: Vec<Id> = {
        let store = open(dir.path(), KeyRing::single("k1", K1), None);
        let ids = datas.iter().map(|d| put(&store, d)).collect();
        // a dictionary under k1 as well
        store
            .engine
            .dicts
            .put(b"dictionary bytes with SECRET-MARKER-7f3a9c inside".to_vec())
            .unwrap();
        ids
    };
    // rotate: k2 active, k1 still configured -> old objects readable, new writes under k2
    let store = open(dir.path(), ring(&[("k1", K1), ("k2", K2)], "k2"), None);
    for (id, d) in ids.iter().zip(&datas) {
        assert_eq!(&store.read_to_vec(id, None).unwrap(), d);
    }
    let extra = secret_text(200_000, 9);
    let fx = put(&store, &extra);
    let enc = enc_stats(&store);
    assert!(
        enc["objects_by_key"]["k1"].as_u64().unwrap() > 0
            && enc["objects_by_key"]["k2"].as_u64().unwrap() > 0,
        "{}",
        enc
    );
    let before = store.rekey_remaining().unwrap();
    assert!(before > 0);
    let mut calls = 0u64;
    let rep = store.rekey(0, &mut |_| calls += 1).unwrap();
    assert!(rep.failed.is_empty(), "{:?}", rep);
    assert_eq!(
        (rep.remaining, rep.rewrapped, rep.encrypted),
        (0, before, 0),
        "{:?}",
        rep
    );
    assert_eq!(rep.dicts_rewrapped, 1);
    assert!(calls >= before);
    let enc = enc_stats(&store);
    assert!(enc["objects_by_key"].get("k1").is_none(), "{}", enc);
    assert!(store.verify_index(true).unwrap().ok());
    // rerun is a no-op (idempotent)
    let rep2 = store.rekey(0, &mut |_| {}).unwrap();
    assert_eq!(
        (rep2.candidates, rep2.remaining, rep2.dicts_rewrapped),
        (0, 0, 0)
    );
    drop(store);
    // k1 removed from the configuration: everything still reads
    let store = open(dir.path(), KeyRing::single("k2", K2), None);
    for (id, d) in ids.iter().zip(&datas) {
        assert_eq!(&store.read_to_vec(id, None).unwrap(), d);
    }
    assert_eq!(store.read_to_vec(&fx, None).unwrap(), extra);
    assert_eq!(
        store
            .engine
            .dicts
            .list_ids()
            .iter()
            .filter(|d| store.engine.dicts.get(d).is_some())
            .count(),
        1
    );
    assert!(store.verify_index(true).unwrap().ok());
    let rep = store.scrub_step(u64::MAX).unwrap();
    assert!(rep.corrupt.is_empty() && rep.unverifiable == 0);
    // superseded k1 copies were compacted away: no k1 envelope is left in any pack or file
    assert_eq!(
        files_containing(&dir.path().join("store"), b"DTE1\x01\x02k1"),
        Vec::<String>::new()
    );
    assert_eq!(files_containing(dir.path(), MARKER), Vec::<String>::new());
}

#[test]
fn missing_key_is_an_error_never_plaintext() {
    let dir = tempfile::tempdir().unwrap();
    let data = secret_text(400_000, 11);
    let fid = {
        let store = open(dir.path(), KeyRing::single("k1", K1), None);
        put(&store, &data)
    };
    let store = open(dir.path(), KeyRing::single("k2", K2), None);
    match store.read_to_vec(&fid, None) {
        Err(StoreError::KeyUnavailable(m)) => assert!(m.contains("\"k1\""), "{}", m),
        other => panic!("expected KeyUnavailable, got {:?}", other.map(|v| v.len())),
    }
    assert!(
        store.quarantined().unwrap().is_empty(),
        "a missing key is configuration, not corruption"
    );
    let rep = store.scrub_step(u64::MAX).unwrap();
    assert!(rep.corrupt.is_empty() && rep.unverifiable > 0);
    let oid = store.chunk_refs(&fid).unwrap().unwrap().1[0].object_id;
    assert!(matches!(
        store.get_object_raw(&oid),
        Err(StoreError::KeyUnavailable(_))
    ));
    assert_eq!(
        enc_stats(&store)["missing_key_ids"],
        serde_json::json!(["k1"])
    );
    // rekey cannot rewrap it either and says so
    let rep = store.rekey(0, &mut |_| {}).unwrap();
    assert!(rep.remaining > 0 && !rep.failed.is_empty());
    drop(store);
    // with encryption disabled the envelope is still never served
    let store = open(dir.path(), KeyRing::disabled(), None);
    assert!(matches!(
        store.read_to_vec(&fid, None),
        Err(StoreError::KeyUnavailable(_))
    ));
}

#[test]
fn legacy_plaintext_store_mixed_then_rekeyed() {
    let dir = tempfile::tempdir().unwrap();
    let old = secret_text(700_000, 13);
    let old_big = secret_random(500_000, 14);
    let (f_old, f_big) = {
        let store = open(dir.path(), KeyRing::disabled(), None);
        (put(&store, &old), put(&store, &old_big))
    };
    assert!(
        !files_containing(dir.path(), MARKER).is_empty(),
        "the legacy store is plaintext"
    );
    let store = open(dir.path(), KeyRing::single("k1", K1), None);
    let new = secret_text(300_000, 15);
    let f_new = put(&store, &new);
    assert_eq!(store.read_to_vec(&f_old, None).unwrap(), old);
    assert_eq!(store.read_to_vec(&f_big, None).unwrap(), old_big);
    assert_eq!(store.read_to_vec(&f_new, None).unwrap(), new);
    let enc = enc_stats(&store);
    let plain = enc["plaintext_objects"].as_u64().unwrap();
    assert!(
        plain > 0 && enc["objects_by_key"]["k1"].as_u64().unwrap() > 0,
        "{}",
        enc
    );
    assert!(store.verify_index(true).unwrap().ok());
    let rep = store.rekey(0, &mut |_| {}).unwrap();
    assert_eq!((rep.encrypted, rep.remaining), (plain, 0), "{:?}", rep);
    assert_eq!(enc_stats(&store)["plaintext_objects"], 0);
    for (id, d) in [(f_old, &old), (f_big, &old_big), (f_new, &new)] {
        assert_eq!(&store.read_to_vec(&id, None).unwrap(), d);
    }
    assert!(store.verify_index(true).unwrap().ok());
    assert_eq!(
        files_containing(dir.path(), MARKER),
        Vec::<String>::new(),
        "superseded plaintext copies are gone"
    );
}

#[test]
fn rekey_is_crash_safe_and_resumable() {
    let dir = tempfile::tempdir().unwrap();
    let datas: Vec<Vec<u8>> = (0..3)
        .map(|i| secret_random(400_000, 20 + i))
        .chain([secret_text(600_000, 30)])
        .collect();
    let ids: Vec<Id> = {
        let store = open(dir.path(), KeyRing::single("k1", K1), None);
        datas.iter().map(|d| put(&store, d)).collect()
    };
    // crash after the new copy is placed (a file renamed over the old one / a pack record
    // appended) but before the index commit, a few objects in
    for crash_at in [3u32, 1] {
        let store = open(dir.path(), ring(&[("k1", K1), ("k2", K2)], "k2"), None);
        let n = Arc::new(AtomicU32::new(0));
        let n2 = n.clone();
        store.set_fail_hook(Some(Arc::new(move |p: &str| {
            p == "install.after_place" && n2.fetch_add(1, Ordering::SeqCst) + 1 == crash_at
        })));
        assert!(matches!(
            store.rekey(0, &mut |_| {}),
            Err(StoreError::Injected(_))
        ));
        drop(store);
    }
    let store = open(dir.path(), ring(&[("k1", K1), ("k2", K2)], "k2"), None);
    assert!(
        store.verify_index(true).unwrap().ok(),
        "{:?}",
        store.verify_index(true).unwrap().problems
    );
    for (id, d) in ids.iter().zip(&datas) {
        assert_eq!(&store.read_to_vec(id, None).unwrap(), d);
    }
    let rep = store.rekey(0, &mut |_| {}).unwrap();
    assert_eq!(rep.remaining, 0, "{:?}", rep);
    drop(store);
    let store = open(dir.path(), KeyRing::single("k2", K2), None);
    for (id, d) in ids.iter().zip(&datas) {
        assert_eq!(&store.read_to_vec(id, None).unwrap(), d);
    }
    assert!(store.verify_index(true).unwrap().ok());
}

#[test]
fn reactor_admin_rekey_cli() {
    let dir = tempfile::tempdir().unwrap();
    let data = secret_text(500_000, 40);
    let fid = {
        let store = open(dir.path(), KeyRing::disabled(), None);
        put(&store, &data)
    };
    let key_hex = hex::encode(K1);
    let out = std::process::Command::new(env!("CARGO_BIN_EXE_reactor-admin"))
        .arg("rekey")
        .env("REACTOR_STATE_DIR", dir.path())
        .env("REACTOR_MASTER_KEY", &key_hex)
        .env_remove("REACTOR_MASTER_KEYS")
        .env_remove("REACTOR_MASTER_KEY_FILE")
        .env_remove("REACTOR_ACTIVE_KEY_ID")
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        out.status.success(),
        "stdout: {}\nstderr: {}",
        stdout,
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(stdout.contains("rekey: done"), "{}", stdout);
    let store = open(
        dir.path(),
        KeyRing::single(crypto::DEFAULT_KEY_ID, K1),
        None,
    );
    assert_eq!(store.read_to_vec(&fid, None).unwrap(), data);
    assert_eq!(enc_stats(&store)["plaintext_objects"], 0);
    assert_eq!(files_containing(dir.path(), MARKER), Vec::<String>::new());
}

#[test]
fn require_encryption_refuses_to_start() {
    let dir = tempfile::tempdir().unwrap();
    let run = |envs: &[(&str, &str)]| {
        let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_core-reactor"));
        c.env("REACTOR_STATE_DIR", dir.path())
            .env("REACTOR_PORT", "0")
            .env("REACTOR_EVOLVE", "false");
        for k in [
            "REACTOR_MASTER_KEY",
            "REACTOR_MASTER_KEYS",
            "REACTOR_MASTER_KEY_FILE",
            "REACTOR_ACTIVE_KEY_ID",
            "REACTOR_REQUIRE_ENCRYPTION",
            "REACTOR_TOKEN",
        ] {
            c.env_remove(k);
        }
        for (k, v) in envs {
            c.env(k, v);
        }
        let mut child = c
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        for _ in 0..200 {
            if let Some(st) = child.try_wait().unwrap() {
                let mut err = String::new();
                std::io::Read::read_to_string(child.stderr.as_mut().unwrap(), &mut err).unwrap();
                return Some((st.code(), err));
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
        None
    };
    let (code, err) = run(&[("REACTOR_REQUIRE_ENCRYPTION", "true")]).expect("must exit");
    assert_eq!(code, Some(2), "{}", err);
    assert!(err.contains("REACTOR_REQUIRE_ENCRYPTION"), "{}", err);
    let (code, err) = run(&[("REACTOR_MASTER_KEY", "not-a-key")]).expect("bad key must exit");
    assert_eq!(code, Some(2), "{}", err);
    let (code, _) = run(&[("REACTOR_MASTER_KEYS", "a:0000000000000000000000000000000000000000000000000000000000000001,b:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAI=")]).expect("ambiguous active key must exit");
    assert_eq!(code, Some(2));
    // with a key (and REACTOR_REQUIRE_ENCRYPTION) it starts and keeps running
    assert!(
        run(&[
            ("REACTOR_REQUIRE_ENCRYPTION", "true"),
            ("REACTOR_MASTER_KEY", &hex::encode(K1))
        ])
        .is_none(),
        "starts with a key"
    );
}
