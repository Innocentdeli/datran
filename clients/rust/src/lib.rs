//! Async client for the Datran core reactor (see `core-reactor/openapi.yaml`).
//!
//! ```no_run
//! # async fn demo() -> datran_client::Result<()> {
//! use datran_client::{ByteRange, Client, UploadOptions};
//! let c = Client::builder("http://127.0.0.1:3005").token("secret").build()?;
//! let out = c.compress(b"hello hello hello".to_vec(), &UploadOptions::default()).await?;
//! assert_eq!(&c.decompress(out.data.clone()).await?[..], b"hello hello hello");
//! let put = c.store_put_file("big.bin", &UploadOptions::default()).await?;
//! let part = c.store_get(&put.file_id, Some(ByteRange::Span(0, 1023))).await?;
//! # let _ = part; Ok(()) }
//! ```

mod error;
mod types;

pub use error::{ApiError, Error, ErrorKind, Result};
pub use reqwest::Body;
pub use types::*;

use bytes::Bytes;
use futures_util::{Stream, StreamExt, TryStreamExt};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE};
use reqwest::{Method, Response, StatusCode};
use std::path::Path;
use std::pin::Pin;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

/// A streamed response body.
pub type ByteStream = Pin<Box<dyn Stream<Item = Result<Bytes>> + Send>>;

/// A single byte range for store reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ByteRange {
    /// `bytes=start-` (to the end).
    From(u64),
    /// `bytes=start-end` (end inclusive).
    Span(u64, u64),
    /// `bytes=-n` (the last n bytes).
    Suffix(u64),
}

impl ByteRange {
    /// The `Range` header value.
    pub fn header_value(&self) -> Result<String> {
        match *self {
            ByteRange::From(s) => Ok(format!("bytes={}-", s)),
            ByteRange::Span(s, e) if e >= s => Ok(format!("bytes={}-{}", s, e)),
            ByteRange::Suffix(n) if n > 0 => Ok(format!("bytes=-{}", n)),
            r => Err(Error::InvalidArgument(format!("invalid range {:?}", r))),
        }
    }
}

/// Parses `bytes start-end/total` (total may be `*`).
pub fn parse_content_range(v: &str) -> Option<(u64, u64, Option<u64>)> {
    let rest = v.trim().strip_prefix("bytes")?.trim_start();
    let (span, total) = rest.split_once('/')?;
    let (a, b) = span.split_once('-')?;
    let total = match total.trim() {
        "*" => None,
        t => Some(t.parse().ok()?),
    };
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?, total))
}

/// Optional upload headers.
#[derive(Debug, Clone, Default)]
pub struct UploadOptions {
    /// `x-content-type` classification hint (MIME).
    pub content_type: Option<String>,
    /// Send `x-reactor-no-sample: 1`.
    pub no_sample: bool,
}

impl UploadOptions {
    pub fn content_type(ct: impl Into<String>) -> Self {
        UploadOptions {
            content_type: Some(ct.into()),
            no_sample: false,
        }
    }
    pub fn no_sample(mut self) -> Self {
        self.no_sample = true;
        self
    }
}

/// Builder for [`Client`].
#[derive(Debug, Clone)]
pub struct ClientBuilder {
    base_url: String,
    token: Option<String>,
    connect_timeout: Duration,
    read_timeout: Duration,
    request_timeout: Option<Duration>,
    max_retries: u32,
    backoff: Duration,
    user_agent: String,
}

impl ClientBuilder {
    /// `x-reactor-token`.
    pub fn token(mut self, t: impl Into<String>) -> Self {
        let t = t.into();
        self.token = if t.is_empty() { None } else { Some(t) };
        self
    }
    /// Sets both the connect timeout and the per-read (idle) timeout. Default 60 s.
    pub fn timeout(mut self, d: Duration) -> Self {
        self.connect_timeout = d;
        self.read_timeout = d;
        self
    }
    pub fn connect_timeout(mut self, d: Duration) -> Self {
        self.connect_timeout = d;
        self
    }
    /// Maximum time between two reads of a response; streaming downloads may take longer overall.
    pub fn read_timeout(mut self, d: Duration) -> Self {
        self.read_timeout = d;
        self
    }
    /// Optional hard deadline for a whole request including the body (off by default).
    pub fn request_timeout(mut self, d: Duration) -> Self {
        self.request_timeout = Some(d);
        self
    }
    /// Retries for idempotent requests (GET/HEAD) on transport errors and 429/502/503/504. Default 3.
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = n;
        self
    }
    /// Base backoff; attempt n waits `backoff·2^(n-1)` (+ jitter, capped at 10 s). Default 200 ms.
    pub fn backoff(mut self, d: Duration) -> Self {
        self.backoff = d;
        self
    }
    pub fn user_agent(mut self, ua: impl Into<String>) -> Self {
        self.user_agent = ua.into();
        self
    }

    pub fn build(self) -> Result<Client> {
        let base = self.base_url.trim_end_matches('/').to_owned();
        let parsed = reqwest::Url::parse(&base)
            .map_err(|e| Error::InvalidArgument(format!("base_url: {}", e)))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(Error::InvalidArgument(format!(
                "base_url scheme must be http or https: {}",
                base
            )));
        }
        let mut b = reqwest::Client::builder()
            .connect_timeout(self.connect_timeout)
            .read_timeout(self.read_timeout)
            .user_agent(self.user_agent);
        if let Some(t) = self.request_timeout {
            b = b.timeout(t);
        }
        Ok(Client {
            http: b.build()?,
            base,
            token: self.token,
            max_retries: self.max_retries,
            backoff: self.backoff,
        })
    }
}

/// Client for one reactor. Cheap to clone (shares the connection pool).
#[derive(Debug, Clone)]
pub struct Client {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
    max_retries: u32,
    backoff: Duration,
}

const RETRY_STATUSES: [u16; 4] = [429, 502, 503, 504];

fn jitter(max_ms: u64) -> u64 {
    if max_ms == 0 {
        return 0;
    }
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0);
    nanos % max_ms
}

impl Client {
    pub fn builder(base_url: impl Into<String>) -> ClientBuilder {
        ClientBuilder {
            base_url: base_url.into(),
            token: None,
            connect_timeout: Duration::from_secs(60),
            read_timeout: Duration::from_secs(60),
            request_timeout: None,
            max_retries: 3,
            backoff: Duration::from_millis(200),
            user_agent: concat!("datran-client-rust/", env!("CARGO_PKG_VERSION")).into(),
        }
    }

    /// Shorthand for `Client::builder(base_url).token(token).build()`.
    pub fn new(base_url: impl Into<String>, token: Option<&str>) -> Result<Client> {
        let mut b = Client::builder(base_url);
        if let Some(t) = token {
            b = b.token(t);
        }
        b.build()
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    // ------------------------------------------------------------------ transport

    fn request(&self, method: Method, path: &str, headers: HeaderMap) -> reqwest::RequestBuilder {
        let mut rb = self
            .http
            .request(method, format!("{}{}", self.base, path))
            .headers(headers);
        if let Some(t) = &self.token {
            rb = rb.header("x-reactor-token", t);
        }
        rb
    }

    async fn check(resp: Response, head: bool) -> Result<Response> {
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status().as_u16();
        let cr = resp
            .headers()
            .get(CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        let body = if head {
            Bytes::new()
        } else {
            resp.bytes().await.unwrap_or_default()
        };
        Err(Error::Api(ApiError::new(status, body, cr)))
    }

    /// GET/HEAD with retries (no body).
    async fn idempotent(&self, method: Method, path: &str, headers: HeaderMap) -> Result<Response> {
        let head = method == Method::HEAD;
        let mut attempt = 0u32;
        loop {
            if attempt > 0 {
                let base = (self.backoff.as_millis() as u64)
                    .saturating_mul(1 << (attempt - 1).min(16))
                    .min(10_000);
                tokio::time::sleep(Duration::from_millis(base + jitter(base / 2 + 1))).await;
            }
            let last = attempt >= self.max_retries;
            match self
                .request(method.clone(), path, headers.clone())
                .send()
                .await
            {
                Err(e) if !last => {
                    let _ = e;
                }
                Err(e) => return Err(Error::Transport(e)),
                Ok(resp) if !last && RETRY_STATUSES.contains(&resp.status().as_u16()) => {}
                Ok(resp) => return Self::check(resp, head).await,
            }
            attempt += 1;
        }
    }

    /// Request with a body: never retried.
    async fn with_body(
        &self,
        method: Method,
        path: &str,
        mut headers: HeaderMap,
        body: Body,
    ) -> Result<Response> {
        headers
            .entry(CONTENT_TYPE)
            .or_insert(HeaderValue::from_static("application/octet-stream"));
        let resp = self
            .request(method, path, headers)
            .body(body)
            .send()
            .await?;
        Self::check(resp, false).await
    }

    async fn json<T: serde::de::DeserializeOwned>(resp: Response) -> Result<T> {
        let b = resp.bytes().await?;
        let b: &[u8] = if b.is_empty() { b"{}" } else { &b };
        serde_json::from_slice(b).map_err(|e| Error::InvalidResponse(format!("bad JSON: {}", e)))
    }

    fn stream(resp: Response) -> ByteStream {
        Box::pin(resp.bytes_stream().map_err(Error::Transport))
    }

    // ------------------------------------------------------------------ system / data plane

    /// `GET /health` (no auth).
    pub async fn health(&self) -> Result<Health> {
        Self::json(
            self.idempotent(Method::GET, "/health", HeaderMap::new())
                .await?,
        )
        .await
    }

    /// `POST /compress` (buffered response). Accepts `Vec<u8>`, `Bytes`, `&'static [u8]`, or a [`Body`].
    pub async fn compress(
        &self,
        data: impl Into<Body>,
        opts: &UploadOptions,
    ) -> Result<CompressResult> {
        let resp = self
            .with_body(Method::POST, "/compress", hints(opts), data.into())
            .await?;
        let meta = compress_meta(resp.headers());
        let data = resp.bytes().await?;
        Ok(CompressResult { meta, data })
    }

    /// `POST /compress` with a streamed response (metadata available immediately).
    pub async fn compress_stream(
        &self,
        data: impl Into<Body>,
        opts: &UploadOptions,
    ) -> Result<(CompressMeta, ByteStream)> {
        let resp = self
            .with_body(Method::POST, "/compress", hints(opts), data.into())
            .await?;
        Ok((compress_meta(resp.headers()), Self::stream(resp)))
    }

    /// `POST /decompress`.
    pub async fn decompress(&self, blob: impl Into<Body>) -> Result<Bytes> {
        let resp = self
            .with_body(Method::POST, "/decompress", HeaderMap::new(), blob.into())
            .await?;
        Ok(resp.bytes().await?)
    }

    /// `POST /decompress` with a streamed response.
    pub async fn decompress_stream(&self, blob: impl Into<Body>) -> Result<ByteStream> {
        let resp = self
            .with_body(Method::POST, "/decompress", HeaderMap::new(), blob.into())
            .await?;
        Ok(Self::stream(resp))
    }

    /// `POST /entropy`.
    pub async fn entropy(&self, data: impl Into<Body>) -> Result<Entropy> {
        Self::json(
            self.with_body(Method::POST, "/entropy", HeaderMap::new(), data.into())
                .await?,
        )
        .await
    }

    /// `GET /evolution/status`.
    pub async fn evolution_status(&self) -> Result<EvolutionStatus> {
        Self::json(
            self.idempotent(Method::GET, "/evolution/status", HeaderMap::new())
                .await?,
        )
        .await
    }

    // ------------------------------------------------------------------ store

    /// `PUT /store/files` with any body (a stream body is sent chunked). Never retried.
    pub async fn store_put(
        &self,
        body: impl Into<Body>,
        opts: &UploadOptions,
    ) -> Result<PutResult> {
        Self::json(
            self.with_body(Method::PUT, "/store/files", hints(opts), body.into())
                .await?,
        )
        .await
    }

    /// Streams an [`AsyncRead`]; with `length` the request uses `Content-Length`, otherwise chunked encoding.
    pub async fn store_put_reader<R>(
        &self,
        reader: R,
        length: Option<u64>,
        opts: &UploadOptions,
    ) -> Result<PutResult>
    where
        R: AsyncRead + Send + 'static,
    {
        let mut h = hints(opts);
        if let Some(n) = length {
            h.insert(CONTENT_LENGTH, HeaderValue::from(n));
        }
        let body = Body::wrap_stream(tokio_util::io::ReaderStream::with_capacity(
            reader,
            64 * 1024,
        ));
        Self::json(self.with_body(Method::PUT, "/store/files", h, body).await?).await
    }

    /// Streams a file from disk with a known length.
    pub async fn store_put_file(
        &self,
        path: impl AsRef<Path>,
        opts: &UploadOptions,
    ) -> Result<PutResult> {
        let f = tokio::fs::File::open(path).await?;
        let len = f.metadata().await?.len();
        self.store_put_reader(f, Some(len), opts).await
    }

    async fn get_resp(&self, file_id: &str, range: Option<ByteRange>) -> Result<Response> {
        let mut h = HeaderMap::new();
        if let Some(r) = range {
            let v = r.header_value()?;
            h.insert(
                RANGE,
                HeaderValue::from_str(&v).map_err(|e| Error::InvalidArgument(e.to_string()))?,
            );
        }
        self.idempotent(Method::GET, &file_path(file_id)?, h).await
    }

    /// `GET /store/files/:id` into memory (206 with a range).
    pub async fn store_get(&self, file_id: &str, range: Option<ByteRange>) -> Result<GetResult> {
        let resp = self.get_resp(file_id, range).await?;
        let mut info = range_info(&resp)?;
        let data = resp.bytes().await?;
        if let Some(n) = info.length {
            if n != data.len() as u64 {
                return Err(Error::InvalidResponse(format!(
                    "truncated body ({} of {} bytes)",
                    data.len(),
                    n
                )));
            }
        }
        if info.status != 206 {
            info.total = Some(data.len() as u64);
            info.end = (data.len() as u64).checked_sub(1);
        }
        info.length = Some(data.len() as u64);
        Ok(GetResult { info, data })
    }

    /// `GET /store/files/:id` as a stream.
    pub async fn store_get_stream(
        &self,
        file_id: &str,
        range: Option<ByteRange>,
    ) -> Result<(RangeInfo, ByteStream)> {
        let resp = self.get_resp(file_id, range).await?;
        Ok((range_info(&resp)?, Self::stream(resp)))
    }

    /// Streams a file (or range) into an [`AsyncWrite`]; returns the range info and bytes written.
    pub async fn store_get_to_writer<W>(
        &self,
        file_id: &str,
        range: Option<ByteRange>,
        w: &mut W,
    ) -> Result<(RangeInfo, u64)>
    where
        W: AsyncWrite + Unpin,
    {
        let (info, mut s) = self.store_get_stream(file_id, range).await?;
        let mut n = 0u64;
        while let Some(chunk) = s.next().await {
            let chunk = chunk?;
            w.write_all(&chunk).await?;
            n += chunk.len() as u64;
        }
        w.flush().await?;
        if let Some(len) = info.length {
            if len != n {
                return Err(Error::InvalidResponse(format!(
                    "truncated body ({} of {} bytes)",
                    n, len
                )));
            }
        }
        Ok((info, n))
    }

    /// `HEAD /store/files/:id`.
    pub async fn store_head(&self, file_id: &str) -> Result<HeadResult> {
        let resp = self
            .idempotent(Method::HEAD, &file_path(file_id)?, HeaderMap::new())
            .await?;
        let h = resp.headers();
        let size = h
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);
        let accept_ranges = header_str(h, "accept-ranges").map(str::to_owned);
        let etag = header_str(h, "etag").map(str::to_owned);
        Ok(HeadResult {
            size,
            accept_ranges,
            etag,
        })
    }

    /// `true` when HEAD succeeds, `false` on 404.
    pub async fn store_exists(&self, file_id: &str) -> Result<bool> {
        match self.store_head(file_id).await {
            Ok(_) => Ok(true),
            Err(e) if e.is_not_found() => Ok(false),
            Err(e) => Err(e),
        }
    }

    /// `DELETE /store/files/:id` (unpin once; never retried). 404 once the file is no longer stored.
    pub async fn store_delete(&self, file_id: &str) -> Result<DeleteResult> {
        let resp = self
            .request(Method::DELETE, &file_path(file_id)?, HeaderMap::new())
            .send()
            .await?;
        Self::json(Self::check(resp, false).await?).await
    }

    /// `GET /store/stats`. 503 ([`ErrorKind::Server`]) when the object store is disabled.
    pub async fn store_stats(&self) -> Result<StoreStats> {
        Self::json(
            self.idempotent(Method::GET, "/store/stats", HeaderMap::new())
                .await?,
        )
        .await
    }

    /// `GET /cluster/status`: node config, per-peer health, sampled holders, top demand and
    /// data-gravity metrics. 503 ([`ErrorKind::Server`]) when data gravity is disabled (no store or no
    /// `REACTOR_CLUSTER_TOKEN`).
    pub async fn cluster_status(&self) -> Result<ClusterStatus> {
        Self::json(
            self.idempotent(Method::GET, "/cluster/status", HeaderMap::new())
                .await?,
        )
        .await
    }
}

/// Low-level access to the internal peer endpoints (`x-cluster-token`), for operators and debugging
/// tools, not applications. Only `/cluster/inventory` and `/cluster/hold/:id` are wrapped (manifests,
/// objects, chunks and unpin are peer-to-peer transfer endpoints, see `openapi.yaml`). A granted hold
/// is a real lease: the holder will not drop the replica for `lease_ms`.
#[derive(Debug, Clone)]
pub struct ClusterAdmin {
    inner: Client,
    token: HeaderValue,
}

impl ClusterAdmin {
    pub fn new(base_url: impl Into<String>, cluster_token: &str) -> Result<ClusterAdmin> {
        Self::from_builder(
            Client::builder(base_url).timeout(Duration::from_secs(30)),
            cluster_token,
        )
    }

    /// Uses the builder's transport settings; any `x-reactor-token` set on it is dropped.
    pub fn from_builder(builder: ClientBuilder, cluster_token: &str) -> Result<ClusterAdmin> {
        let mut builder = builder;
        builder.token = None;
        let token = HeaderValue::from_str(cluster_token)
            .map_err(|e| Error::InvalidArgument(format!("cluster token: {}", e)))?;
        Ok(ClusterAdmin {
            inner: builder.build()?,
            token,
        })
    }

    fn headers(&self) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert("x-cluster-token", self.token.clone());
        h
    }

    /// `GET /cluster/inventory`: full listing without `since`, else the delta after `since`.
    pub async fn inventory(&self, since: Option<u64>, tsince: Option<u64>) -> Result<Inventory> {
        let mut q = Vec::new();
        if let Some(s) = since {
            q.push(format!("since={}", s));
        }
        if let Some(t) = tsince {
            q.push(format!("tsince={}", t));
        }
        let path = if q.is_empty() {
            "/cluster/inventory".to_owned()
        } else {
            format!("/cluster/inventory?{}", q.join("&"))
        };
        Client::json(
            self.inner
                .idempotent(Method::GET, &path, self.headers())
                .await?,
        )
        .await
    }

    /// `POST /cluster/hold/:id?node=..`: asks the node to lease (not drop) its replica; with
    /// `origin` also to take over origin and `pins` pins. Never retried.
    pub async fn hold(
        &self,
        file_id: &str,
        node: &str,
        origin: bool,
        pins: u64,
    ) -> Result<HoldResult> {
        if node.is_empty() || !node.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return Err(Error::InvalidArgument(format!(
                "node id must be alphanumeric: {:?}",
                node
            )));
        }
        let mut path = format!("/cluster/hold/{}?node={}", id_segment(file_id)?, node);
        if origin {
            path.push_str(&format!("&origin=1&pins={}", pins));
        }
        let resp = self
            .inner
            .request(Method::POST, &path, self.headers())
            .header(CONTENT_LENGTH, 0)
            .send()
            .await?;
        Client::json(Client::check(resp, false).await?).await
    }
}

fn hints(o: &UploadOptions) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Some(ct) = &o.content_type {
        if let Ok(v) = HeaderValue::from_str(ct) {
            h.insert("x-content-type", v);
        }
    }
    if o.no_sample {
        h.insert("x-reactor-no-sample", HeaderValue::from_static("1"));
    }
    h
}

fn id_segment(id: &str) -> Result<&str> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(Error::InvalidArgument(format!("invalid file id {:?}", id)));
    }
    Ok(id)
}

fn file_path(id: &str) -> Result<String> {
    Ok(format!("/store/files/{}", id_segment(id)?))
}

fn header_str<'a>(h: &'a HeaderMap, k: &str) -> Option<&'a str> {
    h.get(k).and_then(|v| v.to_str().ok())
}

fn compress_meta(h: &HeaderMap) -> CompressMeta {
    let num = |k: &str| header_str(h, k).and_then(|v| v.trim_end_matches('x').parse::<f64>().ok());
    CompressMeta {
        content_class: header_str(h, "x-reactor-class")
            .unwrap_or_default()
            .to_owned(),
        recipe: header_str(h, "x-reactor-recipe")
            .and_then(|v| serde_json::from_str::<Option<Recipe>>(v).ok())
            .flatten(),
        format: header_str(h, "x-reactor-format")
            .unwrap_or_default()
            .to_owned(),
        original_size: num("x-original-size").unwrap_or(0.0) as u64,
        compressed_size: num("x-compressed-size").unwrap_or(0.0) as u64,
        algo: header_str(h, "x-datran-algo")
            .unwrap_or_default()
            .to_owned(),
        ratio: num("x-datran-ratio").unwrap_or(0.0),
        time_us: num("x-datran-time-us").unwrap_or(0.0) as u64,
        entropy: num("x-datran-entropy").unwrap_or(0.0),
        note: header_str(h, "x-reactor-note").map(str::to_owned),
    }
}

fn range_info(resp: &Response) -> Result<RangeInfo> {
    let h = resp.headers();
    let length = header_str(h, "content-length").and_then(|v| v.parse::<u64>().ok());
    let etag = header_str(h, "etag").map(str::to_owned);
    if resp.status() == StatusCode::PARTIAL_CONTENT {
        if let Some(cr) = header_str(h, "content-range") {
            let (start, end, total) = parse_content_range(cr)
                .ok_or_else(|| Error::InvalidResponse(format!("bad Content-Range {:?}", cr)))?;
            return Ok(RangeInfo {
                status: 206,
                start,
                end: Some(end),
                total,
                length,
                etag,
            });
        }
    }
    Ok(RangeInfo {
        status: resp.status().as_u16(),
        start: 0,
        end: length.and_then(|n| n.checked_sub(1)),
        total: length,
        length,
        etag,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(ByteRange::Span(0, 99).header_value().unwrap(), "bytes=0-99");
        assert_eq!(ByteRange::From(10).header_value().unwrap(), "bytes=10-");
        assert_eq!(ByteRange::Suffix(5).header_value().unwrap(), "bytes=-5");
        assert!(ByteRange::Span(5, 1).header_value().is_err());
        assert!(ByteRange::Suffix(0).header_value().is_err());
        assert_eq!(
            parse_content_range("bytes 0-99/1000"),
            Some((0, 99, Some(1000)))
        );
        assert_eq!(parse_content_range("bytes 5-6/*"), Some((5, 6, None)));
        assert_eq!(parse_content_range("nope"), None);
    }

    #[test]
    fn api_error_parsing() {
        let e = ApiError::new(
            401,
            Bytes::from_static(br#"{"error":"missing or invalid x-reactor-token"}"#),
            None,
        );
        assert_eq!(e.kind, ErrorKind::Unauthorized);
        assert_eq!(e.message, "missing or invalid x-reactor-token");
        let d = format!(r#"{{"error":"x","unknown_dict":"{}"}}"#, "0".repeat(64));
        assert_eq!(
            ApiError::new(400, Bytes::from(d), None).unknown_dict(),
            Some("0".repeat(64))
        );
        let r = ApiError::new(416, Bytes::new(), Some("bytes */1234".into()));
        assert_eq!(r.kind, ErrorKind::RangeNotSatisfiable);
        assert_eq!(r.range_total(), Some(1234));
        assert_eq!(r.message, "Range Not Satisfiable");
        assert_eq!(ErrorKind::from_status(507), ErrorKind::InsufficientStorage);
        assert_eq!(ErrorKind::from_status(502), ErrorKind::Server);
    }

    #[test]
    fn store_models() {
        let s: StoreStats = serde_json::from_str(
            r#"{"chunks":0,"compression_ratio":1.0,"dedup_ratio":1,"evictions":0,"files":0,"full_rejections":0,
            "fusion":{"access_rows":0,"bytes_saved":0,"candidates_evaluated":0,"coaccess_min":8.0,"enabled":true,
            "fusions":0,"last_run_ms":0,"reads_saved":0,"rejected":0,"unfusions":0},"gc":{"collected_bytes":0,
            "collected_objects":0,"grace_ms":600000,"queue_bytes":0,"queue_objects":0,"startup_orphans_removed":0,
            "startup_temp_files_removed":0},"inflight_bytes":0,"inventory_version":0,"live_physical_bytes":0,
            "logical_bytes":0,"max_bytes":null,"objects":0,"physical_bytes":0,"put_bytes":0,"puts":0,"read_bytes":0,
            "reads":0,"scrub":{"bytes_checked":0,"corrupt_found":0,"last_pass_ms":0,"last_step_ms":0,
            "objects_checked":0,"pass_progress_objects":0,"passes_completed":0,"quarantined":0},"super_chunks":0,
            "tombstones":0,"total_ratio":1.0,"unique_bytes":0}"#,
        )
        .unwrap();
        assert_eq!(s.max_bytes, None);
        assert_eq!(s.gc.grace_ms, 600_000);
        assert_eq!(s.fusion.coaccess_min, 8.0);
        assert_eq!(s.group_commit, None);
        assert_eq!(s.cluster, None);
        let mut v: serde_json::Value = serde_json::to_value(&s).unwrap();
        v["group_commit"] = serde_json::json!({"batches":3,"jobs":5,"max_batch":2,"window_ms":2.0});
        v["cluster"] = metrics_json();
        v["packs"] = serde_json::json!({"files":1,"future":[1,2]});
        let s: StoreStats = serde_json::from_value(v).unwrap();
        assert_eq!(s.group_commit.unwrap().jobs, 5);
        assert_eq!(s.cluster.unwrap().unpins_forwarded, 23);
        assert_eq!(s.packs.unwrap()["files"], 1);
        let d: DeleteResult =
            serde_json::from_str(r#"{"file_id":"ab","pins":0,"deleted":true,"forwarded_to":"n1"}"#)
                .unwrap();
        assert_eq!(d.forwarded_to.as_deref(), Some("n1"));
        assert!(serde_json::from_str::<DeleteResult>(r#"{"file_id":"ab","pins":1}"#).is_err());
        let e = ApiError::new(
            507,
            Bytes::from_static(br#"{"error":"store full","needed":10,"used":90,"max":95}"#),
            None,
        );
        assert_eq!(e.message, "store full");
        let f = e.store_full().unwrap();
        assert_eq!((f.needed, f.used, f.max), (10, 90, 95));
    }

    fn metrics_json() -> serde_json::Value {
        let keys = "gossip_rounds pulls pull_bytes pull_failures drops origin_transfers repairs remote_reads \
            remote_read_bytes remote_objects_fetched remote_fetch_bytes remote_fetch_failures cache_hits cache_bytes \
            cache_objects tombstones_applied quarantine_repairs quarantine_repair_failures leases_granted \
            leases_refused leases_active evictions_confirmed unpins_forwarded";
        serde_json::Value::Object(
            keys.split_whitespace()
                .enumerate()
                .map(|(i, k)| (k.to_owned(), (i as u64 + 1).into()))
                .collect(),
        )
    }

    #[test]
    fn cluster_models() {
        let a = "a".repeat(32);
        let b = "b".repeat(32);
        let f = "ab".repeat(32);
        let j = serde_json::json!({
            "node_id": a, "region": null, "tls": false, "cluster_size": 2, "min_replicas": 2,
            "min_replicas_effective": 2, "gravity_pull": 3.0, "demand_half_life_ms": 3600000u64,
            "gossip_interval_ms": 200, "capacity": null, "used": 123,
            "peers": [
                {"url": "http://127.0.0.1:1", "node_id": b, "region": "eu", "healthy": true, "is_self": false,
                 "last_ok_ms": 1700000000000u64, "last_error": null, "last_error_ms": null, "consecutive_failures": 0,
                 "inventory_version": 4, "files": 1, "capacity": null, "used": 99},
                {"url": "http://127.0.0.1:2", "node_id": null, "region": null, "healthy": false, "is_self": false,
                 "last_ok_ms": null, "last_error": "connection refused", "last_error_ms": 1700000000001u64,
                 "consecutive_failures": 3, "inventory_version": 0, "files": 0, "capacity": null, "used": 0}
            ],
            "holders_sample": [{"file_id": f, "holders": [a, b], "local": true, "demand": 0.0}],
            "demand_top": [{"file_id": f, "score": 1.5}],
            "metrics": metrics_json(),
        });
        let s: ClusterStatus = serde_json::from_value(j.clone()).unwrap();
        assert_eq!(
            (s.cluster_size, s.capacity, s.used, s.region.as_deref()),
            (2, None, Some(123), None)
        );
        let p = s.peer(&b).unwrap();
        assert!(p.healthy && !p.is_self && p.files == 1);
        assert_eq!(s.peers[1].node_id, None);
        assert_eq!(s.holders_sample[0].holders, vec![a.clone(), b.clone()]);
        assert_eq!(s.demand_top[0].score, 1.5);
        assert_eq!(s.metrics.gossip_rounds, 1);
        let mut bad = j;
        bad["metrics"].as_object_mut().unwrap().remove("pulls");
        assert!(serde_json::from_value::<ClusterStatus>(bad).is_err());
        let inv: Inventory = serde_json::from_value(serde_json::json!({
            "node_id": a, "region": null, "version": 7, "full": true, "more": false, "capacity": null, "used": 1,
            "added": [f], "removed": [], "tombstones": [{"file_id": f, "deleted_ms": 5}],
            "demand": [{"file_id": f, "score": 2}], "now_ms": 1700000000000u64
        }))
        .unwrap();
        assert_eq!(
            (
                inv.version,
                inv.full,
                inv.more,
                inv.tombstones[0].deleted_ms
            ),
            (7, true, false, 5)
        );
        let h: HoldResult = serde_json::from_str(
            r#"{"file_id":"ab","node_id":"n","granted":false,"expires_ms":0,"lease_ms":600000,"origin_accepted":false,"reason":"not held"}"#,
        )
        .unwrap();
        assert_eq!(h.reason.as_deref(), Some("not held"));
    }

    #[test]
    fn meta_from_headers() {
        let mut h = HeaderMap::new();
        h.insert("x-reactor-class", HeaderValue::from_static("text/plain"));
        h.insert(
            "x-reactor-recipe",
            HeaderValue::from_static(r#"{"codec":"zstd","level":3,"window_log":null,"filter":"none","stride":0,"dict":null}"#),
        );
        h.insert("x-datran-ratio", HeaderValue::from_static("3.68x"));
        h.insert("x-original-size", HeaderValue::from_static("8893"));
        let m = compress_meta(&h);
        assert_eq!(m.recipe.unwrap().codec, "zstd");
        assert_eq!(m.ratio, 3.68);
        assert_eq!(m.original_size, 8893);
        h.insert("x-reactor-recipe", HeaderValue::from_static("null"));
        assert!(compress_meta(&h).recipe.is_none());
    }
}
