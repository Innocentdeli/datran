# Datran reactor SDKs

Client libraries for the Datran core reactor (`core-reactor`). The wire contract is
[`core-reactor/openapi.yaml`](../core-reactor/openapi.yaml) (OpenAPI 3.1); the design is in
[`NETWORK_SPEC.md`](../core-reactor/docs/NETWORK_SPEC.md) §6 and [`EVOLUTION_SPEC.md`](../core-reactor/docs/EVOLUTION_SPEC.md) §5.

| Directory | Language | Package | Dependencies |
| :--- | :--- | :--- | :--- |
| [`python/`](python/README.md) | Python ≥ 3.9 | `datran_client` | stdlib only |
| [`rust/`](rust/README.md) | Rust 2021 (≥ 1.75) | `datran-client` | reqwest (rustls), tokio, serde, thiserror |
| [`cpp/`](cpp/README.md) | C++17 | header-only `datran/client.hpp` | none (Winsock / BSD sockets) |
| [`typescript/`](typescript/README.md) | TypeScript / ESM | `@datran/client` | none at runtime (global `fetch`) |

## Compatibility matrix

| Feature | Python | Rust | C++ | TypeScript |
| :--- | :---: | :---: | :---: | :---: |
| `GET /health` | ✓ | ✓ | ✓ | ✓ |
| `POST /compress`, buffered | ✓ | ✓ | ✓ | ✓ |
| `POST /compress`, streamed upload + download | ✓ file-like / iterable | ✓ `Body` stream | ✓ `std::istream` → `std::ostream` | ✓ `ReadableStream` / async iterable |
| `x-reactor-*` / `x-datran-*` headers parsed (class, recipe, format, sizes, ratio…) | ✓ | ✓ | ✓ | ✓ |
| `POST /decompress` (buffered + streamed) | ✓ | ✓ | ✓ | ✓ |
| `POST /entropy` | ✓ | ✓ | ✓ | ✓ |
| `GET /evolution/status` | ✓ dict | ✓ typed struct | ✓ `json::Value` | ✓ typed |
| `PUT /store/files` known length (`Content-Length`) | ✓ path / file / bytes | ✓ file / reader + len | ✓ file / stream + len | ✓ `Blob` (`fs.openAsBlob`) / bytes |
| `PUT /store/files` unknown length (chunked) | ✓ | ✓ | ✓ | ✓ |
| `GET /store/files/:id` to memory / streamed to sink | ✓ | ✓ | ✓ | ✓ |
| Ranges (`start-end`, `start-`, suffix `-n`), 206 + `Content-Range` parsing, 416 | ✓ | ✓ | ✓ | ✓ |
| `HEAD` / `DELETE` / `GET /store/stats` (incl. `group_commit`, optional `cluster`, loose `packs`; `forwarded_to` on DELETE) | ✓ | ✓ | ✓ | ✓ |
| `GET /cluster/status` (typed `ClusterStatus`) | ✓ | ✓ | ✓ | ✓ |
| Internal `/cluster/inventory` + `POST /cluster/hold/:id` (`x-cluster-token`, low-level `ClusterAdmin`) | ✓ | ✓ | – | ✓ |
| Other internal endpoints (`/cluster/manifests`, `objects`, `chunks`, `unpin`, `/evolution/champions`, `dict`) | – | – | – | – |
| Typed errors with HTTP status | ✓ exception classes | ✓ `Error` + `ErrorKind` | ✓ `ApiError::kind()` | ✓ error classes |
| Retries with backoff (GET/HEAD only) | ✓ | ✓ | ✓ | ✓ |
| Timeouts | socket timeout | connect + read (idle) [+ total] | connect + send/recv | header deadline (+ body for buffered calls) |
| HTTPS | ✓ | ✓ rustls | ✗ use a TLS-terminating proxy | ✓ (runtime `fetch`) |
| Chunked *response* decoding | ✓ (http.client) | ✓ (hyper) | ✓ own parser | ✓ (fetch) |

**Retry policy (all clients).** Only `GET`/`HEAD` are retried (transport errors and 429/502/503/504,
exponential backoff with jitter, default 3 retries, 200 ms base). `PUT /store/files` adds a pin and
`DELETE` removes one, so neither is ever retried automatically; `POST` data-plane calls are not retried either.

**Error mapping (all clients).** 400 bad request (incl. `unknown_dict`), 401 auth, 404 not found
(also: store/cluster not available on this reactor), 405, 413 payload too large, 416 range not satisfiable
(`bytes */size` exposed), 507 insufficient storage, other 5xx server error; connection/timeout/malformed
responses are a separate transport error.

## Running the tests

Every suite runs against a live reactor. Either point it at a running one:

```
REACTOR_URL=http://127.0.0.1:3005 REACTOR_TOKEN=secret <test command>
```

or let the suite start one on an ephemeral port with a temporary `REACTOR_STATE_DIR`:

```
REACTOR_BIN=/path/to/core-reactor[.exe] <test command>
```

(if neither is set, `core-reactor/target/release/core-reactor[.exe]` is used when present; otherwise live tests skip).
Store tests skip automatically while `GET /store/stats` answers 404 (reactor built without the store).
The Python, Rust and TypeScript suites also start a 2-node cluster from `REACTOR_BIN` (peers pointing at
each other, `REACTOR_CLUSTER_TOKEN`, 200 ms gossip) and check peer health, remote reads and forwarded
deletes; they skip when only `REACTOR_URL` is given.

| Client | Command (from its directory) |
| :--- | :--- |
| Python | `python -m unittest -v` |
| Rust | `cargo test` |
| C++ | `cmake -S . -B build && cmake --build build && ./build/datran_client_test` |
| TypeScript | `npm install && npm test` |
