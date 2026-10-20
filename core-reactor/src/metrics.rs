//! Prometheus metrics (`GET /metrics`, NETWORK_SPEC §8).
//!
//! Two kinds of series:
//! - **event series** recorded on the hot path into process-wide collectors (HTTP requests,
//!   codec bytes / latency, fsync latency, group-commit batch sizes, ingest in-flight bytes);
//! - **state series** read at scrape time from the engine, the store's transactional counters and
//!   the cluster (generation / fitness, bytes and ratios, GC / scrub / fusion / pack counters,
//!   encryption, peers, leases) into a per-scrape registry, so they never drift from the
//!   `/store/stats`, `/evolution/status` and `/cluster/status` documents.
//!
//! Label cardinality is bounded by construction: route *templates* (never raw paths), status
//! codes, codec / op names, content classes (a fixed list), key ids (operator-configured, at most
//! 63 per store) and fixed kind names. No file, chunk or object ids, no peer URLs.

use crate::evolution::Engine;
use prometheus::{
    Encoder, Gauge, GaugeVec, Histogram, HistogramOpts, HistogramVec, IntCounter, IntCounterVec,
    IntGauge, IntGaugeVec, Opts, Registry, TextEncoder,
};
use std::sync::OnceLock;
use std::time::Duration;

struct Hot {
    registry: Registry,
    http_requests: IntCounterVec,
    http_duration: HistogramVec,
    codec_bytes: IntCounterVec,
    codec_duration: HistogramVec,
    fsync_duration: HistogramVec,
    group_batch: Histogram,
    ingest_inflight: IntGauge,
    backups: IntCounterVec,
    peer_requests: IntCounterVec,
    peer_duration: HistogramVec,
    peer_bytes: IntCounterVec,
    peer_fallbacks: IntCounter,
    quic_handshake_failures: IntCounterVec,
    quic_0rtt: IntCounterVec,
    quic_early_requests: IntCounterVec,
    quic_server_requests: IntCounterVec,
    quic_server_bytes: IntCounter,
    quic_connections: IntGaugeVec,
}

const LATENCY_BUCKETS: &[f64] = &[
    0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0,
    60.0,
];
const FSYNC_BUCKETS: &[f64] = &[
    0.0001, 0.00025, 0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 1.0,
];

fn hot() -> &'static Hot {
    static HOT: OnceLock<Hot> = OnceLock::new();
    HOT.get_or_init(|| {
        let registry = Registry::new();
        let hv = |name: &str, help: &str, labels: &[&str], buckets: &[f64]| {
            let h = HistogramVec::new(HistogramOpts::new(name, help).buckets(buckets.to_vec()), labels).expect("histogram");
            registry.register(Box::new(h.clone())).expect("register");
            h
        };
        let cv = |name: &str, help: &str, labels: &[&str]| {
            let c = IntCounterVec::new(Opts::new(name, help), labels).expect("counter");
            registry.register(Box::new(c.clone())).expect("register");
            c
        };
        let http_requests = cv("reactor_http_requests_total", "HTTP requests by route template, method and status", &["route", "method", "status"]);
        let http_duration =
            hv("reactor_http_request_duration_seconds", "HTTP request latency (handler, excluding body streaming)", &["route", "method", "status"], LATENCY_BUCKETS);
        let codec_bytes = cv("reactor_codec_bytes_total", "Plaintext bytes processed on the request path by op (compress, verify, decompress) and codec", &["op", "codec"]);
        let codec_duration = hv("reactor_codec_duration_seconds", "Request-path codec latency by op and codec", &["op", "codec"], LATENCY_BUCKETS);
        let fsync_duration = hv("reactor_store_fsync_duration_seconds", "Durability latency: pack fsync and redb index commit", &["kind"], FSYNC_BUCKETS);
        let group_batch = Histogram::with_opts(
            HistogramOpts::new("reactor_store_group_commit_batch_jobs", "Jobs per group-commit batch").buckets(vec![1.0, 2.0, 4.0, 8.0, 16.0, 32.0, 64.0, 128.0]),
        )
        .expect("histogram");
        registry.register(Box::new(group_batch.clone())).expect("register");
        let ingest_inflight = IntGauge::new("reactor_store_ingest_inflight_bytes", "Plaintext bytes handed to compression workers and not yet staged (all uploads)").expect("gauge");
        registry.register(Box::new(ingest_inflight.clone())).expect("register");
        let backups = cv("reactor_store_backups_total", "Online backups by result", &["result"]);
        let peer_requests = cv(
            "reactor_cluster_peer_requests_total",
            "Outgoing node-to-node requests by transport (quic, https, http), method and result (ok, http_error, error)",
            &["transport", "method", "result"],
        );
        let peer_duration = hv("reactor_cluster_peer_request_duration_seconds", "Outgoing node-to-node request latency incl. body", &["transport"], LATENCY_BUCKETS);
        let peer_bytes = cv("reactor_cluster_peer_response_bytes_total", "Response body bytes received from peers by transport", &["transport"]);
        let peer_fallbacks = IntCounter::new("reactor_cluster_peer_fallbacks_total", "Requests sent over HTTP(S) because the QUIC handshake to the peer failed").expect("counter");
        registry.register(Box::new(peer_fallbacks.clone())).expect("register");
        let quic_handshake_failures = cv("reactor_quic_handshake_failures_total", "QUIC handshakes that failed (TLS, mTLS, timeout) by side (client, server)", &["side"]);
        let quic_0rtt = cv("reactor_quic_0rtt_total", "Client 0-RTT attempts by result (accepted, rejected)", &["result"]);
        let quic_early_requests = cv(
            "reactor_quic_early_requests_total",
            "Requests the QUIC server received before the handshake was confirmed (0-RTT), by class (safe = GET/HEAD, unsafe = anything else)",
            &["class"],
        );
        let quic_server_requests = cv("reactor_quic_server_requests_total", "HTTP/3 requests served on the QUIC listener by method and status", &["method", "status"]);
        let quic_server_bytes = IntCounter::new("reactor_quic_server_response_bytes_total", "Response body bytes sent on the QUIC listener").expect("counter");
        registry.register(Box::new(quic_server_bytes.clone())).expect("register");
        let quic_connections = IntGaugeVec::new(Opts::new("reactor_quic_connections", "Open QUIC connections by side (client, server)"), &["side"]).expect("gauge");
        registry.register(Box::new(quic_connections.clone())).expect("register");
        Hot {
            registry,
            http_requests,
            http_duration,
            codec_bytes,
            codec_duration,
            fsync_duration,
            group_batch,
            ingest_inflight,
            backups,
            peer_requests,
            peer_duration,
            peer_bytes,
            peer_fallbacks,
            quic_handshake_failures,
            quic_0rtt,
            quic_early_requests,
            quic_server_requests,
            quic_server_bytes,
            quic_connections,
        }
    })
}

pub fn http_request(route: &str, method: &str, status: u16, elapsed: Duration) {
    let h = hot();
    let s = status.to_string();
    h.http_requests
        .with_label_values(&[route, method, &s])
        .inc();
    h.http_duration
        .with_label_values(&[route, method, &s])
        .observe(elapsed.as_secs_f64());
}

pub fn codec_op(op: &str, codec: &str, bytes: u64, elapsed: Duration) {
    let h = hot();
    h.codec_bytes.with_label_values(&[op, codec]).inc_by(bytes);
    h.codec_duration
        .with_label_values(&[op, codec])
        .observe(elapsed.as_secs_f64());
}

pub fn fsync(kind: &str, elapsed: Duration) {
    hot()
        .fsync_duration
        .with_label_values(&[kind])
        .observe(elapsed.as_secs_f64());
}

pub fn group_commit_batch(jobs: u64) {
    hot().group_batch.observe(jobs as f64);
}

pub fn ingest_inflight_add(delta: i64) {
    if delta != 0 {
        hot().ingest_inflight.add(delta);
    }
}

pub fn backup_done(ok: bool) {
    hot()
        .backups
        .with_label_values(&[if ok { "ok" } else { "error" }])
        .inc();
}

/// One outgoing node-to-node request (`transport` = quic / https / http, `result` = ok /
/// http_error / error).
pub fn peer_request(transport: &str, method: &str, result: &str, elapsed: Duration, bytes: u64) {
    let h = hot();
    h.peer_requests
        .with_label_values(&[transport, method, result])
        .inc();
    h.peer_duration
        .with_label_values(&[transport])
        .observe(elapsed.as_secs_f64());
    if bytes > 0 {
        h.peer_bytes.with_label_values(&[transport]).inc_by(bytes);
    }
}

pub fn peer_fallback() {
    hot().peer_fallbacks.inc();
}

pub fn quic_handshake_failure(side: &str) {
    hot()
        .quic_handshake_failures
        .with_label_values(&[side])
        .inc();
}

pub fn quic_0rtt(accepted: bool) {
    hot()
        .quic_0rtt
        .with_label_values(&[if accepted { "accepted" } else { "rejected" }])
        .inc();
}

pub fn quic_early_request(safe: bool) {
    hot()
        .quic_early_requests
        .with_label_values(&[if safe { "safe" } else { "unsafe" }])
        .inc();
}

pub fn quic_server_request(method: &str, status: u16, bytes: u64) {
    let h = hot();
    h.quic_server_requests
        .with_label_values(&[method, &status.to_string()])
        .inc();
    h.quic_server_bytes.inc_by(bytes);
}

pub fn quic_connections_add(side: &str, delta: i64) {
    hot().quic_connections.with_label_values(&[side]).add(delta);
}

/// Codec name of a blob for the decompress metrics (`legacy` for flags 0x00–0x03).
pub fn blob_codec(blob: &[u8]) -> &'static str {
    match blob {
        [f, _, c, ..] if *f == crate::codec::FLAG_RECIPE => crate::codec::Codec::from_id(*c)
            .map(|c| c.name())
            .unwrap_or("unknown"),
        [] => "empty",
        _ => "legacy",
    }
}

/// Per-scrape registry of state series.
struct Snap {
    reg: Registry,
}

impl Snap {
    fn gauge(&self, name: &str, help: &str, v: f64) {
        if let Ok(g) = Gauge::new(name, help) {
            g.set(v);
            let _ = self.reg.register(Box::new(g));
        }
    }
    fn counter(&self, name: &str, help: &str, v: u64) {
        if let Ok(c) = IntCounter::new(name, help) {
            c.inc_by(v);
            let _ = self.reg.register(Box::new(c));
        }
    }
    fn gauge_vec(&self, name: &str, help: &str, label: &str, rows: &[(String, f64)]) {
        if rows.is_empty() {
            return;
        }
        if let Ok(g) = GaugeVec::new(Opts::new(name, help), &[label]) {
            for (l, v) in rows {
                g.with_label_values(&[l]).set(*v);
            }
            let _ = self.reg.register(Box::new(g));
        }
    }
}

fn num(v: &serde_json::Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}

fn int(v: &serde_json::Value) -> u64 {
    v.as_u64().unwrap_or(0)
}

/// Renders every series in the Prometheus text format (0.0.4).
pub fn render(
    engine: &Engine,
    store: Option<&crate::store::Store>,
    cluster: Option<&crate::cluster::Cluster>,
) -> String {
    let snap = Snap {
        reg: Registry::new(),
    };
    snap.gauge("reactor_up", "1 while the reactor serves requests", 1.0);
    if let Some(p) = crate::workers::pool_threads() {
        snap.gauge(
            "reactor_compress_pool_threads",
            "Threads of the shared compression pool",
            p as f64,
        );
    }

    // evolution
    let st = engine.status();
    let classes = st["classes"].as_array().cloned().unwrap_or_default();
    let mut gens = Vec::new();
    let mut fit = Vec::new();
    let mut ratio = Vec::new();
    let mut samples = Vec::new();
    for c in &classes {
        let name = c["class"].as_str().unwrap_or("unknown").to_string();
        gens.push((name.clone(), num(&c["generation"])));
        samples.push((name.clone(), num(&c["samples"])));
        if c["champion"].is_object() {
            fit.push((name.clone(), num(&c["champion"]["fitness"])));
            ratio.push((name, num(&c["champion"]["ratio"])));
        }
    }
    snap.gauge_vec(
        "reactor_evolution_generation",
        "Evolution generation per content class",
        "class",
        &gens,
    );
    snap.gauge_vec(
        "reactor_evolution_champion_fitness",
        "Held-out fitness of the class champion",
        "class",
        &fit,
    );
    snap.gauge_vec(
        "reactor_evolution_champion_ratio",
        "Held-out compression ratio of the class champion",
        "class",
        &ratio,
    );
    snap.gauge_vec(
        "reactor_evolution_samples",
        "Samples in the class reservoir",
        "class",
        &samples,
    );
    let prof = [(engine.cfg.profile.name().to_string(), 1.0)];
    snap.gauge_vec(
        "reactor_profile",
        "Active REACTOR_PROFILE (value 1)",
        "profile",
        &prof,
    );

    if let Some(s) = store {
        if let Ok(v) = s.stats() {
            store_series(&snap, &v);
        }
    }
    if let Some(c) = cluster {
        let m = c.metrics_json();
        let (healthy, total) = c.peer_health();
        snap.gauge(
            "reactor_cluster_peers",
            "Configured peers (excluding this node)",
            total as f64,
        );
        snap.gauge(
            "reactor_cluster_peers_healthy",
            "Peers whose inventory is fresh",
            healthy as f64,
        );
        for (k, help) in [
            ("gossip_rounds", "Inventory gossip rounds"),
            ("pulls", "Files pulled from peers (gravity / repair)"),
            ("pull_bytes", "Bytes pulled from peers"),
            ("pull_failures", "Failed pulls"),
            ("drops", "Local replicas dropped after leases"),
            ("repairs", "Under-replicated files repaired"),
            ("remote_reads", "Reads served from peers' objects"),
            ("remote_read_bytes", "Bytes served by remote reads"),
            ("remote_fetch_failures", "Failed remote object fetches"),
            (
                "quarantine_repairs",
                "Quarantined objects re-fetched from peers",
            ),
            ("quarantine_repair_failures", "Failed quarantine repairs"),
            ("leases_granted", "Hold-leases granted to peers"),
            ("leases_refused", "Hold-leases refused"),
            ("evictions_confirmed", "Evictions confirmed by peer leases"),
        ] {
            snap.counter(&format!("reactor_cluster_{}_total", k), help, int(&m[k]));
        }
        snap.gauge(
            "reactor_cluster_leases_active",
            "Hold-leases this node currently honours",
            num(&m["leases_active"]),
        );
        snap.gauge(
            "reactor_cluster_cache_bytes",
            "Remote-object cache bytes",
            num(&m["cache_bytes"]),
        );
    }

    let mut families = hot().registry.gather();
    families.extend(snap.reg.gather());
    let mut out = Vec::new();
    if TextEncoder::new().encode(&families, &mut out).is_err() {
        return String::new();
    }
    String::from_utf8(out).unwrap_or_default()
}

fn store_series(snap: &Snap, v: &serde_json::Value) {
    for (k, name, help) in [
        (
            "logical_bytes",
            "reactor_store_logical_bytes",
            "Bytes of all files as uploaded",
        ),
        (
            "unique_bytes",
            "reactor_store_unique_bytes",
            "Plaintext bytes of live objects (after dedup)",
        ),
        (
            "physical_bytes",
            "reactor_store_physical_bytes",
            "Stored bytes of all objects incl. those awaiting GC",
        ),
        (
            "live_physical_bytes",
            "reactor_store_live_physical_bytes",
            "Stored bytes of live objects",
        ),
        (
            "dedup_ratio",
            "reactor_store_dedup_ratio",
            "logical / unique",
        ),
        (
            "compression_ratio",
            "reactor_store_compression_ratio",
            "unique / live physical",
        ),
        (
            "total_ratio",
            "reactor_store_total_ratio",
            "logical / live physical",
        ),
        ("files", "reactor_store_files", "Files in the store"),
        ("objects", "reactor_store_objects", "Indexed objects"),
        (
            "super_chunks",
            "reactor_store_super_chunks",
            "Fused super-chunk objects",
        ),
        ("chunks", "reactor_store_chunks", "Indexed chunks"),
        (
            "tombstones",
            "reactor_store_tombstones",
            "Delete tombstones",
        ),
        (
            "inflight_bytes",
            "reactor_store_admitted_inflight_bytes",
            "Bytes admitted against capacity by in-progress writes",
        ),
    ] {
        snap.gauge(name, help, num(&v[k]));
    }
    if let Some(m) = v["max_bytes"].as_u64() {
        snap.gauge(
            "reactor_store_max_bytes",
            "Configured capacity (REACTOR_STORE_MAX_BYTES)",
            m as f64,
        );
    }
    for (k, name, help) in [
        ("puts", "reactor_store_puts_total", "Files written"),
        (
            "put_bytes",
            "reactor_store_put_bytes_total",
            "Bytes written by puts",
        ),
        ("reads", "reactor_store_reads_total", "Range reads"),
        (
            "read_bytes",
            "reactor_store_read_bytes_total",
            "Bytes returned by reads",
        ),
        (
            "full_rejections",
            "reactor_store_full_rejections_total",
            "Writes refused for capacity",
        ),
        (
            "evictions",
            "reactor_store_evictions_total",
            "Replicas evicted for capacity",
        ),
    ] {
        snap.counter(name, help, int(&v[k]));
    }
    let g = &v["group_commit"];
    snap.counter(
        "reactor_store_group_commit_batches_total",
        "Group-commit batches",
        int(&g["batches"]),
    );
    snap.counter(
        "reactor_store_group_commit_jobs_total",
        "Jobs committed by group commit",
        int(&g["jobs"]),
    );
    let gc = &v["gc"];
    snap.gauge(
        "reactor_store_gc_queue_objects",
        "Unreferenced objects waiting for the GC grace period",
        num(&gc["queue_objects"]),
    );
    snap.gauge(
        "reactor_store_gc_queue_bytes",
        "Stored bytes waiting for GC",
        num(&gc["queue_bytes"]),
    );
    snap.counter(
        "reactor_store_gc_collected_objects_total",
        "Objects collected by GC",
        int(&gc["collected_objects"]),
    );
    snap.counter(
        "reactor_store_gc_collected_bytes_total",
        "Stored bytes collected by GC",
        int(&gc["collected_bytes"]),
    );
    let f = &v["fusion"];
    snap.counter(
        "reactor_store_fusions_total",
        "Chunk fusions",
        int(&f["fusions"]),
    );
    snap.counter(
        "reactor_store_unfusions_total",
        "Super-chunk unfusions",
        int(&f["unfusions"]),
    );
    snap.counter(
        "reactor_store_fusion_bytes_saved_total",
        "Stored bytes saved by fusion",
        int(&f["bytes_saved"]),
    );
    snap.counter(
        "reactor_store_fusion_reads_saved_total",
        "Object reads saved by fusion",
        int(&f["reads_saved"]),
    );
    let sc = &v["scrub"];
    snap.counter(
        "reactor_store_scrub_objects_checked_total",
        "Objects verified by the scrubber",
        int(&sc["objects_checked"]),
    );
    snap.counter(
        "reactor_store_scrub_bytes_checked_total",
        "Stored bytes verified by the scrubber",
        int(&sc["bytes_checked"]),
    );
    snap.counter(
        "reactor_store_scrub_corrupt_total",
        "Corrupt objects found",
        int(&sc["corrupt_found"]),
    );
    snap.counter(
        "reactor_store_scrub_passes_total",
        "Completed scrub passes",
        int(&sc["passes_completed"]),
    );
    snap.gauge(
        "reactor_store_quarantined_objects",
        "Objects currently quarantined",
        num(&sc["quarantined"]),
    );
    let p = &v["packs"];
    snap.gauge("reactor_store_packs", "Pack files", num(&p["packs"]));
    snap.gauge(
        "reactor_store_packed_objects",
        "Objects stored in packs",
        num(&p["packed_objects"]),
    );
    snap.gauge(
        "reactor_store_pack_bytes",
        "Committed pack bytes",
        num(&p["bytes"]),
    );
    snap.gauge(
        "reactor_store_pack_dead_bytes",
        "Dead bytes in packs (reclaimed by compaction)",
        num(&p["dead_bytes"]),
    );
    snap.counter(
        "reactor_store_pack_compactions_total",
        "Pack compactions",
        int(&p["compactions"]),
    );
    snap.counter(
        "reactor_store_pack_fsyncs_total",
        "Pack fsyncs",
        int(&p["fsyncs"]),
    );
    let i = &v["ingest"];
    snap.gauge(
        "reactor_store_ingest_inflight_peak_bytes",
        "Highest per-upload in-flight compression bytes",
        num(&i["inflight_peak_bytes"]),
    );
    snap.counter(
        "reactor_store_ingest_pool_chunks_total",
        "Chunks compressed on the shared pool",
        int(&i["pool_chunks"]),
    );
    let e = &v["encryption"];
    snap.gauge(
        "reactor_store_encryption_enabled",
        "1 when a master key is configured",
        if e["enabled"].as_bool() == Some(true) {
            1.0
        } else {
            0.0
        },
    );
    let mut by_key: Vec<(String, f64)> = e["objects_by_key"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), num(v))).collect())
        .unwrap_or_default();
    by_key.push(("plaintext".into(), num(&e["plaintext_objects"])));
    snap.gauge_vec(
        "reactor_store_encrypted_objects",
        "Objects by key id they are sealed under (plaintext = unencrypted)",
        "key_id",
        &by_key,
    );
    snap.gauge(
        "reactor_store_encryption_missing_keys",
        "Key ids in use that are not configured",
        e["missing_key_ids"]
            .as_array()
            .map(|a| a.len())
            .unwrap_or(0) as f64,
    );
}
