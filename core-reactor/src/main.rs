use core_reactor::cluster::tls::{self, TlsSettings};
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
    let port: u16 = std::env::var("REACTOR_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3005);
    let bind: IpAddr = match std::env::var("REACTOR_BIND") {
        Ok(b) if !b.trim().is_empty() => match b.trim().parse() {
            Ok(ip) => ip,
            Err(_) => {
                eprintln!("[reactor] invalid REACTOR_BIND {:?}", b);
                std::process::exit(2);
            }
        },
        _ => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    let reactor_token = std::env::var("REACTOR_TOKEN").ok().filter(|t| !t.is_empty()).map(|t| Arc::new(t.into_bytes()));
    let gossip_cfg = GossipConfig::from_env();
    if let Err(e) = server::check_bind(bind, reactor_token.is_some(), gossip_cfg.cluster_token.is_some()) {
        eprintln!("[reactor] {}", e);
        std::process::exit(2);
    }
    if reactor_token.is_none() {
        println!("[reactor] REACTOR_TOKEN not set: endpoints are unauthenticated (loopback only)");
    }
    if gossip_cfg.cluster_token.is_none() && !gossip_cfg.peers.is_empty() {
        println!("[reactor] REACTOR_PEERS set but REACTOR_CLUSTER_TOKEN missing: gossip disabled");
    }

    let evo_cfg = EvoConfig::from_env();
    let engine = Arc::new(tokio::task::spawn_blocking(move || Engine::new(evo_cfg)).await.expect("engine init"));
    let gossip = Arc::new(Gossip::new(gossip_cfg));
    let store_enabled = std::env::var("REACTOR_STORE")
        .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off"))
        .unwrap_or(true);
    let store = if store_enabled {
        let cfg = StoreConfig::from_env(&engine.cfg.state_dir);
        let e = engine.clone();
        match tokio::task::spawn_blocking(move || Store::open(cfg, e)).await.expect("store init") {
            Ok(s) => Some(Arc::new(s)),
            Err(err) => {
                eprintln!("[reactor] failed to open object store: {}", err);
                std::process::exit(2);
            }
        }
    } else {
        None
    };
    // Data gravity (NETWORK_SPEC §4): needs the store and a cluster token.
    let cluster = match (&store, gossip_cfg_token_set(&gossip)) {
        (Some(s), true) => {
            let cfg = match ClusterConfig::from_env(&engine.cfg.state_dir) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[reactor] cannot create node id: {}", e);
                    std::process::exit(2);
                }
            };
            match Cluster::start(cfg, s.clone()) {
                Ok(c) => Some(c),
                Err(e) => {
                    eprintln!("[reactor] data gravity disabled: {}", e);
                    std::process::exit(2);
                }
            }
        }
        _ => None,
    };
    let tls = TlsSettings::from_env();
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
    println!(
        "[reactor] Datran core reactor listening on {}://{} (evolution {}, state dir {}, gossip {}, peers {}, store {}, gravity {})",
        if tls.is_some() { "https" } else { "http" },
        addr,
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

    tls::serve(listener, server::router(state), tls, shutdown_signal()).await.expect("Reactor server failed");

    println!("[reactor] shutting down; saving evolution state");
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
        Ok(Ok(())) => println!("[reactor] state saved to {}", engine.state_path().display()),
        Ok(Err(err)) => eprintln!("[reactor] failed to save state: {}", err),
        Err(err) => eprintln!("[reactor] failed to save state: {}", err),
    }
}
