# datran-client (Rust)

Async client for the Datran core reactor built on `reqwest` (rustls, no OpenSSL) and `tokio`.
Standalone crate (own `[workspace]`, own `target/`), not part of the `core-reactor` workspace.

## Install

```toml
[dependencies]
datran-client = { path = "../clients/rust" }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

## Usage

```rust
use datran_client::{ByteRange, Client, ErrorKind, UploadOptions};
use futures_util::StreamExt;
use std::time::Duration;

#[tokio::main]
async fn main() -> datran_client::Result<()> {
    let c = Client::builder("http://127.0.0.1:3005")
        .token("secret")
        .timeout(Duration::from_secs(30))     // connect + per-read idle timeout
        .max_retries(3)                        // GET/HEAD only
        .build()?;

    // Data plane
    let out = c.compress(b"{\"a\":1}".repeat(1000), &UploadOptions::content_type("application/json")).await?;
    println!("{} {:?} {} -> {}", out.meta.content_class, out.meta.recipe, out.meta.original_size, out.meta.compressed_size);
    let original = c.decompress(out.data).await?;

    // Streaming download of the decoded bytes
    let mut s = c.decompress_stream(c.compress(original.to_vec(), &UploadOptions::default()).await?.data).await?;
    while let Some(chunk) = s.next().await { let _ = chunk?; }

    println!("{:?}", c.entropy(&b"hello"[..]).await?);
    println!("{:?}", c.evolution_status().await?.classes);

    // Object store
    let put = c.store_put_file("video.mp4", &UploadOptions::content_type("video/mp4")).await?; // Content-Length
    let reader = tokio::fs::File::open("log.txt").await?;
    let _ = c.store_put_reader(reader, None, &UploadOptions::default()).await?;              // chunked
    let part = c.store_get(&put.file_id, Some(ByteRange::Span(0, 1023))).await?;           // 206
    println!("{:?}", part.info);
    let mut f = tokio::fs::File::create("copy.mp4").await?;
    c.store_get_to_writer(&put.file_id, None, &mut f).await?;                               // streamed
    println!("{:?} {:?}", c.store_head(&put.file_id).await?, c.store_stats().await?);
    c.store_delete(&put.file_id).await?;                                                     // unpin

    match c.store_get(&put.file_id, None).await {
        Err(e) if e.kind() == Some(ErrorKind::NotFound) => println!("gone"),
        other => { other?; }
    }
    Ok(())
}
```

## Errors

`datran_client::Error` (thiserror): `Transport(reqwest::Error)`, `Api(ApiError { status, kind, message, body,
content_range })`, `Io`, `InvalidResponse`, `InvalidArgument`. Helpers: `status()`, `kind()` (`ErrorKind::{BadRequest,
Unauthorized, NotFound, MethodNotAllowed, PayloadTooLarge, RangeNotSatisfiable, InsufficientStorage, Server, Other}`),
`is_not_found()`, `is_timeout()`, `ApiError::unknown_dict()`, `ApiError::range_total()`.

## Tests

```
REACTOR_BIN=../../core-reactor/target/release/core-reactor.exe cargo test
REACTOR_URL=http://127.0.0.1:3005 REACTOR_TOKEN=secret cargo test
```

Each integration test starts its own reactor (ephemeral port, temp state dir) and kills it on drop. Store
tests print `SKIPPED: …` and return early while `/store/stats` answers 404 (Rust has no runtime skip).
