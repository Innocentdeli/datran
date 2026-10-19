use core_reactor::cluster::quic::{QuicServer, QuicServerSettings};
use core_reactor::cluster::tls::{self, TlsSettings};
use core_reactor::cluster::transport::{PeerClient, TransportConfig};
use core_reactor::cluster::{Cluster, ClusterConfig};
use core_reactor::evolution::{spawn_scheduler, Engine, EvoConfig};
use core_reactor::gossip::{Gossip, GossipConfig};
use core_reactor::server::{self, AppState};
use core_reactor::store::{Store, StoreConfig};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = term => {}
    }
}

fn gossip_cfg_token_set(g: &Gossip) -> bool {
    g.cfg.cluster_token.is_some()
}

#[tokio::main]
async fn main() {
    core_reactor::logging::init();
    let port: u16 = std::env::var("REACTOR_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3005);
    let bind: IpAddr = match std::env::var("REACTOR_BIND") {
        Ok(b) if !b.trim().is_empty() => match b.trim().parse() {
            Ok(ip) => ip,
            Err(_) => {
                tracing::error!("invalid REACTOR_BIND {:?}", b);
                std::process::exit(2);
            }
        },
        _ => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    let reactor_token = std::env::var("REACTOR_TOKEN").ok().filter(|t| !t.is_empty()).map(|t| Arc::new(t.into_bytes()));
    let gossip_cfg = GossipConfig::from_env();
    if let Err(e) = server::check_bind(bind, reactor_token.is_some(), gossip_cfg.cluster_token.is_some()) {
        tracing::error!("{}", e);
        std::process::exit(2);
    }
    if reactor_token.is_none() {
        tracing::info!("REACTOR_TOKEN not set: endpoints are unauthenticated (loopback only)");
    }
    if gossip_cfg.cluster_token.is_none() && !gossip_cfg.peers.is_empty() {
        tracing::info!("REACTOR_PEERS set but REACTOR_CLUSTER_TOKEN missing: gossip disabled");
    }

    // Encryption at rest (NETWORK_SPEC Â§7): bad key configuration or REACTOR_REQUIRE_ENCRYPTION
    // without a key refuses to start; no key at all runs unencrypted with a loud warning.
    let keys = match core_reactor::crypto::keyring_for_startup() {
        Ok(k) => Arc::new(k),
        Err(e) => {
            tracing::error!("{}", e);
            std::process::exit(2);
        }
    };
    let mut evo_cfg = EvoConfig::from_env();
    evo_cfg.keys = keys.clone();
    // QUIC (NETWORK_SPEC §4 "QUIC transport"): a listener without a certificate, or mTLS
    // without a CA, refuses to start.
    let tls = TlsSettings::from_env();
    let quic_settings = match QuicServerSettings::from_env(tls.as_ref()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("{}", e);
            std::process::exit(2);
        }
    };
    // One peer client (QUIC / HTTP(S)) for recipe gossip and data gravity.
    let transport = match TransportConfig::from_env().and_then(PeerClient::new) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!("{}", e);
            std::process::exit(2);
        }
    };
    let engine = Arc::new(tokio::task::spawn_blocking(move || Engine::new(evo_cfg)).await.expect("engine init"));
    let gossip = Arc::new(Gossip::with_client(gossip_cfg, transport.clone()));
    let store_enabled = std::env::var("REACTOR_STORE")
        .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off"))
        .unwrap_or(true);
    let store = if store_enabled {
        let cfg = StoreConfig::from_env(&engine.cfg.state_dir);
        let e = engine.clone();
        match tokio::task::spawn_blocking(move || Store::open(cfg, e)).await.expect("store init") {
            Ok(s) => Some(Arc::new(s)),
            Err(err) => {
                tracing::error!("failed to open object store: {}", err);
                std::process::exit(2);
            }
        }
    } else {
        None
    };
    // Data gravity (NETWORK_SPEC Â§4): needs the store and a cluster token.
    let quic_stats = Arc::new(core_reactor::cluster::quic::QuicServerStats::default());
    let cluster = match (&store, gossip_cfg_token_set(&gossip)) {
        (Some(s), true) => {
            let mut cfg = match ClusterConfig::from_env(&engine.cfg.state_dir) {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!("cluster configuration: {}", e);
                    std::process::exit(2);
                }
            };
            if quic_settings.is_some() {
                cfg.quic_server = Some(quic_stats.clone());
            }
            match Cluster::start_with_client(cfg, s.clone(), transport.clone()) {
                Ok(c) => Some(c),
                Err(e) => {
                    tracing::error!("data gravity disabled: {}", e);
                    std::process::exit(2);
                }
            }
        }
        _ => None,
    };
    let state = AppState {
        engine: engine.clone(),
        gossip: gossip.clone(),
        reactor_token,
        max_output: core_reactor::reactor::max_output_bytes(),
        store: store.clone(),
        cluster: cluster.clone(),
    };

    let (tx, rx) = tokio::sync::watch::channel(false);
    let scheduler = spawn_scheduler(engine.clone(), rx.clone());
    let store_task = store.clone().map(|s| s.spawn_tasks(rx.clone()));
    let cluster_task = cluster.clone().map(|c| c.spawn_loop(rx.clone()));
    let gossip_task = gossip.clone().spawn_loop(engine.clone(), rx);

    let addr = SocketAddr::new(bind, port);
    let listener = tokio::net::TcpListener::bind(addr).await.expect("Failed to bind TCP listener");
    let quic_server = match &quic_settings {
        Some((qport, qs)) => match QuicServer::start_with_stats(SocketAddr::new(bind, *qport), server::peer_router(state.clone()), qs, quic_stats.clone()) {
            Ok(q) => {
                tracing::info!(
                    mtls = qs.client_ca.is_some(),
                    zero_rtt = qs.tuning.zero_rtt,
                    congestion = ?qs.tuning.congestion,
                    max_streams = qs.tuning.max_streams,
                    "QUIC (HTTP/3) peer listener on udp://{}",
                    q.local_addr()
                );
                Some(q)
            }
            Err(e) => {
                tracing::error!("QUIC listener: {}", e);
                std::process::exit(2);
            }
        },
        None => None,
    };
    tracing::info!(
        profile = engine.cfg.profile.name(),
        "Datran core reactor listening on {}://{} (encryption {}, evolution {}, state dir {}, gossip {}, peers {}, store {}, gravity {})",
        if tls.is_some() { "https" } else { "http" },
        addr,
        match keys.active_id() {
            Some(id) => format!("on, active key {}", id),
            None => "OFF".into(),
        },
        if engine.cfg.enabled { "on" } else { "frozen" },
        engine.cfg.state_dir.display(),
        if gossip.enabled() { "on" } else { "off" },
        gossip.cfg.peers.len(),
        if store.is_some() { "on" } else { "off" },
        match &cluster {
            Some(c) => format!("on, node {}", c.cfg.node_id),
            None => "off".into(),
        }
    );

    tls::serve(listener, server::router_with(state, server::MetricsAuth::from_env(bind)), tls, shutdown_signal()).await.expect("Reactor server failed");

    tracing::info!("shutting down; saving evolution state");
    if let Some(q) = &quic_server {
        q.close();
        let _ = tokio::time::timeout(Duration::from_secs(5), q.wait_idle()).await;
    }
    let _ = tx.send(true);
    let _ = tokio::time::timeout(Duration::from_secs(60), scheduler).await;
    if let Some(t) = store_task {
        let _ = tokio::time::timeout(Duration::from_secs(30), t).await;
    }
    if let Some(t) = gossip_task {
        let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
    }
    if let Some(t) = cluster_task {
        let _ = tokio::time::timeout(Duration::from_secs(5), t).await;
    }
    let e = engine.clone();
    match tokio::task::spawn_blocking(move || e.save()).await {
        Ok(Ok(())) => tracing::info!("state saved to {}", engine.state_path().display()),
        Ok(Err(err)) => tracing::error!("failed to save state: {}", err),
        Err(err) => tracing::error!("failed to save state: {}", err),
    }
}
