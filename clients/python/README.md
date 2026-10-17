# datran-client (Python)

Stdlib-only (`http.client`), typed (`py.typed`) client for the Datran core reactor. Python ≥ 3.9.

## Install

```
pip install ./clients/python          # or: pip install -e ./clients/python
```

## Usage

```python
from datran_client import Client, NotFoundError, RangeNotSatisfiableError

c = Client("http://127.0.0.1:3005", token="secret", timeout=30)

# Data plane
r = c.compress(b'{"a":1}' * 1000, content_type="application/json")
print(r.content_class, r.recipe, r.format, r.original_size, r.compressed_size, r.ratio)
assert c.decompress(r.data) == b'{"a":1}' * 1000

# Streaming (file-like in, file-like out; unknown-length inputs go chunked)
with open("in.bin", "rb") as src, open("in.blob", "wb") as dst:
    meta = c.compress_to(src, dst, no_sample=True)
with open("in.blob", "rb") as src, open("out.bin", "wb") as dst:
    c.decompress_to(src, dst)

print(c.entropy(b"hello"))            # EntropyResult(size_bytes=5, entropy_bits=1.92..., suggested_routing='symbit')
print(c.evolution_status()["classes"])

# Object store
put = c.store_put("video.mp4", content_type="video/mp4")      # path: streamed with Content-Length
put2 = c.store_put(iter([b"part1", b"part2"]))                # iterable: chunked transfer
data = c.store_get_bytes(put.file_id)                          # whole file
part = c.store_get(put.file_id, range=(0, 1023))               # 206, part.start/end/total
tail = c.store_get_bytes(put.file_id, range=-4096)             # last 4 KiB
with open("copy.mp4", "wb") as f:
    c.store_get_to(put.file_id, f)                             # streamed to disk
print(c.store_head(put.file_id).size, c.store_stats())
c.store_delete(put.file_id)                                    # unpin (once per successful PUT)
```

`RangeSpec` is `"bytes=…"`, `(start, end_inclusive_or_None)` or a negative int for a suffix.

## Errors

All errors derive from `DatranError`:
`TransportError` (connect/timeout/malformed response) and `ApiError(status, message, body, headers)` with
subclasses `BadRequestError` (`.unknown_dict`), `AuthError`, `NotFoundError`, `MethodNotAllowedError`,
`PayloadTooLargeError`, `RangeNotSatisfiableError` (`.size`), `InsufficientStorageError`, `ServerError`.

## Retries and timeouts

`timeout` is the socket timeout (connect and each read/write). GET/HEAD calls are retried on transport
errors and 429/502/503/504 (`max_retries=3`, `backoff=0.2` s exponential with jitter). PUT/DELETE/POST are never
retried. A streamed download (`store_get_to`) that fails mid-body raises `TransportError`; resume with a range.

## Tests

```
REACTOR_BIN=../../core-reactor/target/release/core-reactor.exe python -m unittest -v
REACTOR_URL=http://127.0.0.1:3005 REACTOR_TOKEN=secret python -m unittest -v
```

`tests/test_unit.py` runs offline against a stub server (retry policy, chunked uploads, error mapping).
`tests/test_live.py` needs a reactor; store tests skip while `/store/stats` returns 404.
