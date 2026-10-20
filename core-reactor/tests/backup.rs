//! Online backup / verified restore (NETWORK_SPEC §2 "Backup & restore").

mod common;

use common::{random_bytes, test_config, text};
use core_reactor::crypto::KeyRing;
use core_reactor::evolution::Engine;
use core_reactor::store::backup::{self, read_manifest};
use core_reactor::store::{Id, PutOptions, Store, StoreConfig, StoreError};
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const K1: [u8; 32] = [0x42; 32];

fn keys() -> KeyRing {
    KeyRing::single("k1", K1)
}

fn open(state_dir: &Path, keys: KeyRing) -> Store {
    let mut ec = test_config(state_dir, 9);
    ec.persist = false;
    ec.keys = Arc::new(keys);
    let engine = Arc::new(Engine::new(ec));
    let mut sc = StoreConfig::new(state_dir.join("store"));
    sc.gc_grace = Duration::from_millis(0);
    sc.fusion = false;
    sc.pack_threshold = 32 * 1024; // compressible chunks -> packs, random chunks -> object files
    sc.pack_max_bytes = 1 << 20; // several sealed packs
    Store::open(sc, engine).unwrap()
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

fn doc(i: u64) -> Vec<u8> {
    if i.is_multiple_of(2) {
        text(200_000 + (i as usize % 7) * 10_000, i)
    } else {
        random_bytes(150_000 + (i as usize % 5) * 1000, i)
    }
}

fn restore_into(
    src: &Path,
    dst: &Path,
    keys: fn() -> KeyRing,
    force: bool,
) -> core_reactor::store::Result<backup::RestoreReport> {
    let verify = move |state_dir: &Path| {
        let s = open(state_dir, keys());
        s.verify_index(true)
    };
    backup::restore(src, dst, force, &keys(), &verify)
}

#[test]
fn backup_during_concurrent_writes_restores_byte_exact() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("node");
    let store = open(&state, keys());
    let originals: Mutex<HashMap<Id, Vec<u8>>> = Mutex::new(HashMap::new());
    let mut before = Vec::new();
    for i in 0..12 {
        let d = doc(i);
        let id = put(&store, &d);
        before.push(id);
        originals.lock().unwrap().insert(id, d);
    }
    // a deleted file: its objects are in the GC queue (the backup must still be consistent)
    store.delete(&before[0]).unwrap();
    let deleted_before = before[0];
    let before = &before[1..];

    let dest = root.path().join("bk1");
    let stop = AtomicBool::new(false);
    let rep = std::thread::scope(|s| {
        for w in 0..3u64 {
            let (store, originals, stop) = (&store, &originals, &stop);
            s.spawn(move || {
                let mut i = 100 + w * 1000;
                while !stop.load(Ordering::Relaxed) {
                    let d = doc(i);
                    let id = put(store, &d);
                    originals.lock().unwrap().insert(id, d);
                    // churn: deletes + GC + compaction attempts while the backup copies
                    if i.is_multiple_of(3) {
                        store.delete(&id).unwrap();
                        let _ = store.gc_with_grace(0);
                    }
                    i += 1;
                }
            });
        }
        std::thread::sleep(Duration::from_millis(150));
        let r = store.backup(&dest, None);
        stop.store(true, Ordering::Relaxed);
        r
    })
    .unwrap();
    assert!(rep.objects_copied > 0 && rep.packs_copied > 0, "{:?}", rep);
    assert_eq!(rep.key_ids, vec!["k1".to_string()]);
    let m = read_manifest(&dest).unwrap();
    assert!(m.files.iter().any(|f| f.path == "store/index.redb"));
    drop(store);

    // restore needs the master key: refused clearly without it
    let target = root.path().join("restored");
    match restore_into(&dest, &target, KeyRing::disabled, false) {
        Err(StoreError::KeyUnavailable(m)) => assert!(m.contains("k1"), "{}", m),
        other => panic!("expected KeyUnavailable, got {:?}", other.map(|_| ())),
    }
    let r = restore_into(&dest, &target, keys, false).unwrap();
    assert!(r.fsck.as_ref().unwrap().ok());

    let restored = open(&target, keys());
    let files = restored.list_files(None, 100_000).unwrap();
    let originals = originals.into_inner().unwrap();
    for id in before {
        assert!(
            files.iter().any(|f| f.file_id == *id),
            "file written before the backup is missing"
        );
    }
    assert!(
        !files.iter().any(|f| f.file_id == deleted_before),
        "file deleted before the snapshot came back"
    );
    for f in &files {
        let want = originals
            .get(&f.file_id)
            .expect("restored file was never written");
        assert_eq!(
            &restored.read_to_vec(&f.file_id, None).unwrap(),
            want,
            "byte mismatch"
        );
    }
    assert!(restored.verify_index(true).unwrap().ok());

    // a non-empty target is refused unless forced
    assert!(matches!(
        restore_into(&dest, &target, keys, false),
        Err(StoreError::Invalid(_))
    ));
    drop(restored);
    restore_into(&dest, &target, keys, true).unwrap();
}

#[test]
fn corrupted_backup_file_is_refused() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("node");
    let store = open(&state, keys());
    for i in 0..6 {
        put(&store, &doc(i));
    }
    let dest = root.path().join("bk");
    store.backup(&dest, None).unwrap();
    drop(store);
    let m = read_manifest(&dest).unwrap();
    for victim in ["store/objects/", "store/packs/"] {
        let e = m.files.iter().find(|f| f.path.starts_with(victim)).unwrap();
        let p = e.path.split('/').fold(dest.clone(), |p, s| p.join(s));
        let mut b = std::fs::read(&p).unwrap();
        let mid = b.len() / 2;
        b[mid] ^= 0x01;
        std::fs::write(&p, &b).unwrap();
        let target = root
            .path()
            .join(format!("restored-{}", victim.replace('/', "_")));
        match restore_into(&dest, &target, keys, false) {
            Err(StoreError::Corrupt(msg)) => assert!(msg.contains(&e.path), "{}", msg),
            other => panic!("corrupt backup restored: {:?}", other.map(|_| ())),
        }
        assert!(
            !target.join("store").exists(),
            "half-restored store left behind"
        );
        b[mid] ^= 0x01;
        std::fs::write(&p, &b).unwrap();
    }
    // intact again: restores
    restore_into(&dest, &root.path().join("ok"), keys, false).unwrap();
}

#[test]
fn incremental_backup_copies_only_new_objects() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("node");
    let store = open(&state, keys());
    let mut data = HashMap::new();
    for i in 0..8 {
        let d = doc(i);
        data.insert(put(&store, &d), d);
    }
    let full = store.backup(&root.path().join("full"), None).unwrap();
    assert_eq!(full.objects_reused, 0);
    // second backup without changes: nothing but the index / state / active pack is copied
    let same = store
        .backup(&root.path().join("same"), Some(&root.path().join("full")))
        .unwrap();
    assert_eq!(same.objects_copied, 0);
    assert_eq!(same.objects_reused, full.objects_copied);

    // new incompressible files -> new file objects
    let before_objects = full.objects_copied;
    let mut new_ids = Vec::new();
    for i in 0..3 {
        let d = random_bytes(140_000, 9000 + i);
        let id = put(&store, &d);
        new_ids.push(id);
        data.insert(id, d);
    }
    let inc = store
        .backup(&root.path().join("inc"), Some(&root.path().join("same")))
        .unwrap();
    assert_eq!(inc.objects_reused, before_objects, "{:?}", inc);
    assert!(
        inc.objects_copied > 0 && inc.objects_copied <= 3 * 3,
        "{:?}",
        inc
    );
    assert!(
        inc.bytes_copied < full.bytes_copied,
        "{:?} vs {:?}",
        inc,
        full
    );
    // reused entries point at the backup that physically holds them (one hop)
    let m = read_manifest(&root.path().join("inc")).unwrap();
    let full_abs = std::fs::canonicalize(root.path().join("full"))
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert!(m
        .files
        .iter()
        .filter(|f| f.path.starts_with("store/objects/"))
        .any(|f| f.base.as_deref() == Some(full_abs.as_str())));
    drop(store);

    let target = root.path().join("restored");
    restore_into(&root.path().join("inc"), &target, keys, false).unwrap();
    let restored = open(&target, keys());
    for (id, d) in &data {
        assert_eq!(&restored.read_to_vec(id, None).unwrap(), d);
    }
    drop(restored);

    // the backup set moved elsewhere together (e.g. container path -> host path): bases resolve
    // to siblings with the same name
    let moved = root.path().join("moved");
    std::fs::create_dir_all(&moved).unwrap();
    for n in ["full", "same", "inc"] {
        std::fs::rename(root.path().join(n), moved.join(n)).unwrap();
    }
    restore_into(
        &moved.join("inc"),
        &root.path().join("restored2"),
        keys,
        false,
    )
    .unwrap();
}
