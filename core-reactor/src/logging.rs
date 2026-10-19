//! Structured logging (NETWORK_SPEC §8).
//!
//! `REACTOR_LOG_FORMAT=json` emits one JSON object per line (timestamp, level, target, message,
//! fields, current span incl. `request_id`); anything else emits human-readable lines. The level
//! filter comes from `REACTOR_LOG` (or `RUST_LOG`), default `info`.
//!
//! Never log secrets or user data: master keys, tokens (`x-reactor-token`, `x-cluster-token`,
//! `REACTOR_METRICS_TOKEN`), request / response bodies, or file contents. Ids of files and
//! objects are content hashes and may be logged; HTTP paths are logged as route templates.

use tracing_subscriber::{fmt, EnvFilter};

/// Installs the global subscriber (idempotent: a second call is a no-op).
pub fn init() {
    let filter = std::env::var("REACTOR_LOG")
        .ok()
        .or_else(|| std::env::var("RUST_LOG").ok())
        .and_then(|s| EnvFilter::try_new(s).ok())
        .unwrap_or_else(|| EnvFilter::new("info"));
    let json = std::env::var("REACTOR_LOG_FORMAT").is_ok_and(|v| v.trim().eq_ignore_ascii_case("json"));
    // stderr, like the eprintln! output this replaced (stdout stays free for CLI output)
    let res = if json {
        fmt().json().with_writer(std::io::stderr).with_env_filter(filter).with_current_span(true).with_span_list(false).with_target(true).try_init()
    } else {
        fmt().with_writer(std::io::stderr).with_env_filter(filter).with_target(true).try_init()
    };
    let _ = res;
}
