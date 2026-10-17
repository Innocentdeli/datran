# datran/client.hpp (C++17)

Header-only client for the Datran core reactor with **no external dependencies**: a minimal HTTP/1.1
implementation over Winsock (Windows) or BSD sockets (Linux/macOS), plus a small JSON parser
(`datran::json::Value`).

## TLS limitation

**Plain HTTP only.** `https://` base URLs are rejected with `ArgumentError`. To reach a reactor over TLS,
run a local TLS-terminating proxy (stunnel, nginx, Caddy, HAProxy, …) and point the client at its plain-HTTP
side on loopback, e.g. stunnel `client = yes`, `accept = 127.0.0.1:3006`, `connect = reactor.example:443`,
then `Client("http://127.0.0.1:3006", token)`. Do not send tokens in clear text over untrusted networks.

## Install

Copy `include/datran/client.hpp`, or with CMake:

```cmake
add_subdirectory(clients/cpp)          # or FetchContent
target_link_libraries(app PRIVATE datran::client)   # adds ws2_32 on Windows
```

Without CMake: `g++ -std=c++17 -Iclients/cpp/include app.cpp [-lws2_32 on Windows]`.

## Usage

```cpp
#include <datran/client.hpp>
#include <fstream>
#include <iostream>

int main() {
    datran::Client c("http://127.0.0.1:3005", "secret", /*timeout_ms*/ 30000);

    // Data plane
    auto r = c.compress(std::string(10000, 'a'), {"text/plain", /*no_sample*/ false});
    std::cout << r.meta.content_class << " " << r.meta.recipe.dump() << " " << r.meta.ratio << "\n";
    std::string back = c.decompress(r.data);

    std::ifstream in("big.bin", std::ios::binary);
    std::ofstream out("big.blob", std::ios::binary);
    auto meta = c.compress_stream(in, out);          // chunked upload, streamed download

    std::cout << c.entropy("hello").entropy_bits << "\n";
    std::cout << c.evolution_status()["classes"].size() << "\n";

    // Object store
    auto put = c.store_put_file("video.mp4", {"video/mp4", false});           // Content-Length, streamed
    auto part = c.store_get(put.file_id, datran::ByteRange::span(0, 1023));   // 206
    auto tail = c.store_get(put.file_id, datran::ByteRange::suffix(4096));
    std::ofstream copy("copy.mp4", std::ios::binary);
    c.store_get_to(put.file_id, copy);                                         // streamed to disk
    auto st = c.store_stats();                                                 // typed StoreStats (+ .raw)
    std::cout << c.store_head(put.file_id).size << " dedup " << st.dedup_ratio << " gc " << st.gc.queue_bytes << "\n";
    auto del = c.store_delete(put.file_id);                                    // unpin -> {file_id, pins, deleted}

    try {
        c.store_get(put.file_id);
    } catch (const datran::ApiError& e) {
        if (e.kind() == datran::ErrorKind::NotFound) std::cout << "gone\n";
    }
}
```

Other entry points: `decompress_stream(istream&, ostream&)`, `store_put(const std::string&)`,
`store_put_stream(istream&, opts, optional<length>)` (chunked when the length is unknown),
`store_put_source(Source)`, `store_get_to(id, Sink)`, `store_exists`, `cluster_status` (typed
`ClusterStatus`: peers, sampled holders, demand, `ClusterMetrics`; `.raw` keeps the JSON), `health`.
The internal `x-cluster-token` endpoints are not wrapped in C++. A 507 from `store_put*` carries
`ApiError::store_full()` → `{needed, used, max}`.

## HTTP implementation notes

* One connection per request (`Connection: close`); concurrent calls on one `Client` are safe.
* Responses: status line + headers (case-insensitive, repeated headers joined), 1xx skipped, body framed by
  `Transfer-Encoding: chunked` (extensions and trailers handled), `Content-Length`, or read-to-close;
  no body for HEAD/204/304. Truncated bodies and malformed framing raise `TransportError`.
* Requests: `Content-Length` for buffers and known-length streams, chunked otherwise.
* Timeouts: non-blocking connect with `select`/`poll`, then `SO_RCVTIMEO`/`SO_SNDTIMEO` per operation.
* Errors: `datran::Error` → `TransportError` (`is_timeout()`), `ArgumentError`, `ApiError` (`status()`, `kind()`,
  `server_message()`, `unknown_dict()`, `range_total()`).
* Retries: GET/HEAD only on transport errors and 429/502/503/504 (exponential backoff + jitter). A streamed
  download that fails after bytes reached an `ostream` is not retried.

## Tests

```
cmake -S . -B build -G Ninja && cmake --build build
REACTOR_BIN=/path/to/core-reactor.exe ./build/datran_client_test
REACTOR_URL=http://127.0.0.1:3005 REACTOR_TOKEN=secret ./build/datran_client_test
```

Offline tests cover the JSON parser, HTTP response parsing (chunked, Content-Length, 100-continue, HEAD,
read-to-close, malformed input) and error mapping; live tests need a reactor. Store tests report
`SKIPPED` while `/store/stats` returns 404. On MinGW the test binary is linked `-static`.
