mod common;

use common::*;
use core_reactor::classify::{self, BINARY_NUMERIC, TEXT_JSON};
use core_reactor::codec::{decode_any, Filter};
use core_reactor::evolution::{score_recipe, seed_population, Engine, POPULATION_SIZE};
use core_reactor::recipe::Recipe;
use std::sync::Arc;

fn feed(engine: &Engine, docs: &[Vec<u8>], hint: Option<&str>) {
    for d in docs {
        let out = engine.compress(d, hint, true);
        assert_eq!(
            decode_any(&out.blob, 64 << 20, &|id| engine.dicts.get(id)).unwrap(),
            *d
        );
    }
}

fn json_corpus() -> Vec<Vec<u8>> {
    (0..8)
        .map(|i| json_logs(24 * 1024 + (i as usize) * 1000, i))
        .collect()
}

fn f32_corpus() -> Vec<Vec<u8>> {
    (0..8).map(|i| f32_sensor(6_000, 100 + i)).collect()
}

fn samples(docs: &[Vec<u8>]) -> Vec<Arc<Vec<u8>>> {
    // held-out split = odd upload indices (each class is fed in order)
    docs.iter()
        .skip(1)
        .step_by(2)
        .map(|d| Arc::new(d.clone()))
        .collect()
}

#[test]
fn evolution_beats_baseline_and_differs_per_class() {
    let dir = tempfile::tempdir().unwrap();
    let engine = ratio_only_engine(dir.path(), 42);
    let (json, f32s) = (json_corpus(), f32_corpus());
    assert_eq!(classify::classify(&json[0], None), TEXT_JSON);
    assert_eq!(classify::classify(&f32s[0], None), BINARY_NUMERIC);
    feed(&engine, &json, None);
    feed(&engine, &f32s, None);
    assert_eq!(engine.sample_count(TEXT_JSON), 8);
    assert_eq!(engine.sample_count(BINARY_NUMERIC), 8);
    assert!(engine.due_classes().contains(&TEXT_JSON));
    assert_eq!(engine.held_out(TEXT_JSON), samples(&json));
    assert_eq!(engine.held_out(BINARY_NUMERIC), samples(&f32s));

    for (class, docs) in [(TEXT_JSON, &json), (BINARY_NUMERIC, &f32s)] {
        let s = samples(docs);
        let baseline = score_recipe(&Recipe::baseline(), &s, None, 0.0, 0.0, 64 << 20).unwrap();
        let first = engine.run_generation(class).unwrap();
        assert_eq!(first.generation, 1);
        // generation 1 scores the seeded population, including the baseline
        let seeded = first
            .scored
            .iter()
            .find(|m| m.recipe == Recipe::baseline())
            .unwrap();
        assert!((seeded.score.as_ref().unwrap().fitness - baseline.fitness).abs() < 1e-12);
        let mut last = first;
        for _ in 0..5 {
            last = engine.run_generation(class).unwrap();
        }
        let champ = last.champion.unwrap();
        assert_eq!(champ.generation, 6);
        assert!(
            champ.score.fitness >= baseline.fitness,
            "{}: {} < {}",
            class,
            champ.score.fitness,
            baseline.fitness
        );
        assert!(
            champ.score.ratio > baseline.ratio,
            "{}: ratio {} vs {}",
            class,
            champ.score.ratio,
            baseline.ratio
        );
        // champion is verified lossless when re-scored
        let rescored = score_recipe(
            &champ.recipe,
            &s,
            engine.dicts.get(&[0; 32]),
            0.0,
            0.0,
            64 << 20,
        );
        assert!(rescored.is_some() || champ.recipe.dict.is_some());
        assert_eq!(engine.population(class).len(), POPULATION_SIZE);
        println!(
            "{}: baseline ratio {:.3} -> champion {} ratio {:.3}",
            class,
            baseline.ratio,
            champ.recipe.label(),
            champ.score.ratio
        );
    }
    let cj = engine.champion(TEXT_JSON).unwrap().recipe;
    let cn = engine.champion(BINARY_NUMERIC).unwrap().recipe;
    assert_ne!(cj, cn);
    assert_ne!(
        cn.filter,
        Filter::None,
        "numeric champion should use a filter: {}",
        cn.label()
    );
    assert_eq!(
        cj.filter,
        Filter::None,
        "json champion should not need a filter: {}",
        cj.label()
    );

    // /compress now uses the champion
    let out = engine.compress(&f32s[0], None, false);
    assert_eq!(out.recipe.as_ref(), Some(&cn));
    // nothing changed (no new sample) => not due
    assert!(!engine.due_classes().contains(&BINARY_NUMERIC));
}

#[test]
fn default_weights_champion_is_best_of_generation() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = test_config(dir.path(), 7);
    cfg.persist = false;
    let engine = Engine::new(cfg);
    feed(&engine, &f32_corpus()[..6], None);
    let r = engine.run_generation(BINARY_NUMERIC).unwrap();
    let base = r
        .scored
        .iter()
        .find(|m| m.recipe == Recipe::baseline())
        .unwrap();
    let champ = r.champion.unwrap();
    assert!(champ.score.fitness >= base.score.as_ref().unwrap().fitness);
    assert!(champ.score.enc_mib_s > 0.0 && champ.score.dec_mib_s > 0.0);
    assert!(
        !dir.path().join("state.json").exists(),
        "persist=false must not write"
    );
}

#[test]
fn persistence_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let before = {
        let engine = ratio_only_engine(dir.path(), 1);
        feed(&engine, &f32_corpus()[..4], None);
        engine.run_generation(BINARY_NUMERIC).unwrap();
        engine.run_generation(BINARY_NUMERIC).unwrap();
        engine.save().unwrap();
        engine.snapshot()
    };
    let text = std::fs::read_to_string(dir.path().join("state.json")).unwrap();
    assert!(text.contains("binary/numeric"));
    // samples are never persisted
    assert!(!text.contains("samples\":["));
    let leftovers: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
        .collect();
    assert!(leftovers.is_empty(), "temp file left behind");

    let engine = ratio_only_engine(dir.path(), 2);
    let after = engine.snapshot();
    assert_eq!(before.classes, after.classes);
    let ch = engine.champion(BINARY_NUMERIC).unwrap();
    assert_eq!(ch.generation, 2);
    assert_eq!(engine.champion_recipe(BINARY_NUMERIC), ch.recipe);
    assert_eq!(
        engine.sample_count(BINARY_NUMERIC),
        0,
        "reservoir is memory only"
    );

    // a corrupt state file is ignored, not fatal
    std::fs::write(dir.path().join("state.json"), b"{not json").unwrap();
    let engine = ratio_only_engine(dir.path(), 3);
    assert!(engine.champion(BINARY_NUMERIC).is_none());
}

#[test]
fn dictionary_training_improves_small_json() {
    let dir = tempfile::tempdir().unwrap();
    let engine = ratio_only_engine(dir.path(), 9);
    let docs: Vec<Vec<u8>> = (0..40).map(|i| small_json(1000 + i)).collect();
    assert!(docs.iter().all(|d| d.len() < 2048));
    feed(&engine, &docs, Some("application/json"));
    assert_eq!(engine.sample_count(TEXT_JSON), 32);

    let r = engine.run_generation(TEXT_JSON).unwrap();
    let id = r
        .dict_trained
        .clone()
        .expect("dictionary should be trained");
    assert!(dir
        .path()
        .join("dicts")
        .join(format!("{}.dict", id))
        .exists());
    assert_eq!(engine.class_dicts(TEXT_JSON), vec![id.clone()]);

    // trained on the train split only, every recipe scored on the held-out split only
    assert!(!r.dict_train_seqs.is_empty() && r.dict_train_seqs.iter().all(|s| s % 2 == 0));
    assert!(r.scored_seqs.len() >= 4 && r.scored_seqs.iter().all(|s| s % 2 == 1));

    let best_plain = r
        .scored
        .iter()
        .filter(|m| m.recipe.dict.is_none())
        .find_map(|m| m.score.clone())
        .unwrap();
    let best_dict = r
        .scored
        .iter()
        .filter(|m| m.recipe.dict.is_some())
        .find_map(|m| m.score.clone())
        .unwrap();
    assert_eq!(best_dict.samples, r.scored_seqs.len());
    assert_eq!(best_plain.samples, r.scored_seqs.len());
    println!(
        "small json, held-out ({} samples): best plain ratio {:.3}, best dict ratio {:.3} ({:.2}x)",
        r.scored_seqs.len(),
        best_plain.ratio,
        best_dict.ratio,
        best_dict.ratio / best_plain.ratio
    );
    assert!(
        best_dict.ratio > best_plain.ratio * 1.2,
        "held-out: dict {} vs plain {}",
        best_dict.ratio,
        best_plain.ratio
    );
    let champ = r.champion.unwrap();
    assert_eq!(champ.recipe.dict.as_deref(), Some(id.as_str()));

    // new uploads are encoded with the dictionary and decode via the store
    let fresh = small_json(5555);
    let out = engine.compress(&fresh, None, false);
    assert_eq!(
        out.recipe.as_ref().and_then(|r| r.dict.clone()),
        Some(id.clone())
    );
    assert_eq!(
        decode_any(&out.blob, 1 << 20, &|i| engine.dicts.get(i)).unwrap(),
        fresh
    );
    let no = decode_any(&out.blob, 1 << 20, &|_| None);
    assert!(no.is_err());

    // no retraining without enough new uploads
    feed(&engine, &docs[..3], None);
    assert!(engine
        .run_generation(TEXT_JSON)
        .unwrap()
        .dict_trained
        .is_none());

    // large samples (median >= 64 KiB) never train
    let dir2 = tempfile::tempdir().unwrap();
    let e2 = ratio_only_engine(dir2.path(), 9);
    feed(
        &e2,
        &(0..16).map(|i| json_logs(70 * 1024, i)).collect::<Vec<_>>(),
        None,
    );
    assert!(e2.run_generation(TEXT_JSON).unwrap().dict_trained.is_none());
}

/// Held-out samples carry a repeated secret; train samples carry a repeated public marker.
/// The trained dictionary must pick up the train marker but never the held-out secret.
#[test]
fn dictionary_never_sees_held_out_samples() {
    let dir = tempfile::tempdir().unwrap();
    let engine = ratio_only_engine(dir.path(), 21);
    let docs: Vec<Vec<u8>> = (0..24u64)
        .map(|i| {
            let mut d = small_json(7000 + i);
            let marker = if i % 2 == 1 {
                format!("HELDOUT-SECRET-{:04}-", i % 4)
            } else {
                "TRAIN-PUBLIC-MARKER-".to_string()
            };
            d.extend_from_slice(marker.repeat(8).as_bytes());
            d
        })
        .collect();
    feed(&engine, &docs, Some("application/json"));
    assert_eq!(engine.sample_count(TEXT_JSON), 24);
    let r = engine.run_generation(TEXT_JSON).unwrap();
    let id = r.dict_trained.expect("dictionary trained");
    assert_eq!(r.dict_train_seqs, (0..24).step_by(2).collect::<Vec<u64>>());
    assert_eq!(r.scored_seqs, (1..24).step_by(2).collect::<Vec<u64>>());
    let dict = std::fs::read(dir.path().join("dicts").join(format!("{}.dict", id))).unwrap();
    let contains = |needle: &[u8]| dict.windows(needle.len()).any(|w| w == needle);
    assert!(
        contains(b"TRAIN-PUBLIC-MARKER"),
        "control: train content should be in the dictionary"
    );
    assert!(
        !contains(b"HELDOUT"),
        "dictionary must not contain held-out content"
    );
    assert!(
        !contains(b"SECRET"),
        "dictionary must not contain held-out content"
    );
}

#[test]
fn sampling_rules() {
    let dir = tempfile::tempdir().unwrap();
    let mut cfg = test_config(dir.path(), 5);
    cfg.sample_bytes_max = 1000;
    let engine = Engine::new(cfg);
    // x-reactor-no-sample
    engine.compress(&json_logs(5000, 1), None, false);
    assert_eq!(engine.sample_count(TEXT_JSON), 0);
    assert!(engine.due_classes().is_empty());
    // reservoir cap and prefix size
    for i in 0..50 {
        engine.compress(&json_logs(5000, i), None, true);
    }
    assert_eq!(engine.sample_count(TEXT_JSON), 32);
    let st = engine.status();
    let cls = st["classes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["class"] == "text/json")
        .unwrap()
        .clone();
    assert_eq!(cls["samples"], 32);
    assert_eq!(cls["stats"]["samples_seen"], 50);
    assert_eq!(cls["stats"]["compress_count"], 51);
    // high-entropy data is not sampled and falls back to legacy raw
    let rnd = random_bytes(100_000, 3);
    let out = engine.compress(&rnd, None, true);
    assert_eq!(out.class, classify::MEDIA_COMPRESSED);
    assert!(out.recipe.is_none());
    assert_eq!(out.blob[0], 0x02);
    assert_eq!(&out.blob[1..], &rnd[..]);
    assert_eq!(engine.sample_count(classify::MEDIA_COMPRESSED), 0);
    // empty input
    let out = engine.compress(&[], None, true);
    assert_eq!(out.blob, vec![0x02]);

    // frozen evolution: champions used, nothing sampled or scheduled
    let dir2 = tempfile::tempdir().unwrap();
    let mut cfg = test_config(dir2.path(), 5);
    cfg.enabled = false;
    let frozen = Engine::new(cfg);
    let out = frozen.compress(&json_logs(5000, 1), None, true);
    assert_eq!(out.recipe, Some(Recipe::baseline()));
    assert_eq!(frozen.sample_count(TEXT_JSON), 0);
    assert!(frozen.due_classes().is_empty());
}

#[test]
fn seeds_are_valid_and_distinct() {
    let seeds = seed_population();
    assert_eq!(seeds.len(), POPULATION_SIZE);
    for (i, s) in seeds.iter().enumerate() {
        s.validate().unwrap();
        assert!(!seeds[..i].contains(s));
    }
    assert_eq!(seeds[0], Recipe::baseline());
}

#[test]
fn immigrants_are_scored_locally() {
    let dir = tempfile::tempdir().unwrap();
    let engine = ratio_only_engine(dir.path(), 11);
    feed(&engine, &f32_corpus()[..4], None);
    let imm = Recipe::new(core_reactor::codec::Codec::Brotli, 7).with_filter(Filter::Delta, 4);
    assert_eq!(
        engine.add_immigrants(BINARY_NUMERIC, vec![imm.clone(), imm.clone()]),
        1
    );
    assert_eq!(
        engine.add_immigrants(classify::MEDIA_COMPRESSED, vec![imm.clone()]),
        0
    );
    let r = engine.run_generation(BINARY_NUMERIC).unwrap();
    let m = r.scored.iter().find(|m| m.recipe == imm).unwrap();
    assert_eq!(m.origin, "immigrant");
    let local = score_recipe(&imm, &samples(&f32_corpus()[..4]), None, 0.0, 0.0, 64 << 20).unwrap();
    assert!((m.score.as_ref().unwrap().fitness - local.fitness).abs() < 1e-12);
    assert!(engine.pending_immigrants(BINARY_NUMERIC).is_empty());
}

#[test]
fn profiles_set_weights_seeds_and_default_recipe() {
    use core_reactor::codec::Codec;
    use core_reactor::evolution::{EvoConfig, Profile};
    assert_eq!(Profile::parse("SPEED"), Some(Profile::Speed));
    assert_eq!(Profile::parse("ratio"), Some(Profile::Ratio));
    assert_eq!(Profile::parse("bogus"), None);
    for p in [Profile::Speed, Profile::Balanced, Profile::Ratio] {
        let seeds = p.seeds();
        assert_eq!(seeds.len(), POPULATION_SIZE);
        assert_eq!(seeds[0], p.default_recipe());
        assert!(seeds.iter().all(|r| r.validate().is_ok()));
        let mut uniq = seeds.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), seeds.len(), "{:?} seeds must be distinct", p);
    }
    assert_eq!(Profile::Balanced.seeds(), seed_population());
    let speed = Profile::Speed.seeds();
    assert!(speed.iter().any(|r| r.codec == Codec::Lz4));
    assert!(speed
        .iter()
        .all(|r| r.codec != Codec::Brotli && (r.codec != Codec::Zstd || r.level <= 3)));
    let (se, sd) = Profile::Speed.weights();
    let (be, bd) = Profile::Balanced.weights();
    let (re, rd) = Profile::Ratio.weights();
    assert!(se > be && sd > bd && re < be && rd < bd);

    let dir = tempfile::tempdir().unwrap();
    let mut c = EvoConfig::new(dir.path()).with_profile(Profile::Speed);
    c.persist = false;
    assert_eq!((c.w_enc, c.w_dec), (se, sd));
    let e = Engine::new(c);
    assert_eq!(e.champion_recipe("text/json"), Recipe::new(Codec::Zstd, 1));
    let out = e.compress(
        &common::json_logs(20_000, 1),
        Some("application/json"),
        true,
    );
    assert_eq!(out.recipe, Some(Recipe::new(Codec::Zstd, 1)));
    let r = e.run_generation("text/json").unwrap();
    assert!(r
        .scored
        .iter()
        .any(|m| m.recipe.codec == Codec::Lz4 && m.score.is_some()));
    assert_eq!(e.status()["profile"], "speed");
}
