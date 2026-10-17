//! Optional TLS for the reactor's HTTP server (`REACTOR_TLS_CERT` / `REACTOR_TLS_KEY`, PEM) via
//! axum-server + rustls. Peers trust a private CA with `REACTOR_TLS_CA` (see `build_client`).

use axum::Router;
use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct TlsSettings {
    pub cert: PathBuf,
    pub key: PathBuf,
}

impl TlsSettings {
    /// Both `REACTOR_TLS_CERT` and `REACTOR_TLS_KEY` must be set.
    pub fn from_env() -> Option<TlsSettings> {
        let cert = std::env::var("REACTOR_TLS_CERT").ok().filter(|s| !s.trim().is_empty())?;
        let key = std::env::var("REACTOR_TLS_KEY").ok().filter(|s| !s.trim().is_empty())?;
        Some(TlsSettings { cert: PathBuf::from(cert), key: PathBuf::from(key) })
    }
}

/// Serves `app` on `listener`, over TLS when `tls` is set, until `shutdown` resolves.
pub async fn serve(
    listener: tokio::net::TcpListener,
    app: Router,
    tls: Option<TlsSettings>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    match tls {
        None => axum::serve(listener, app).with_graceful_shutdown(shutdown).await,
        Some(t) => {
            let config = axum_server::tls_rustls::RustlsConfig::from_pem_file(&t.cert, &t.key).await?;
            let std_listener = listener.into_std()?;
            let handle = axum_server::Handle::new();
            let h = handle.clone();
            tokio::spawn(async move {
                shutdown.await;
                h.graceful_shutdown(Some(Duration::from_secs(10)));
            });
            axum_server::from_tcp_rustls(std_listener, config).handle(handle).serve(app.into_make_service()).await
        }
    }
}
