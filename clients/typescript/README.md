# @datran/client (TypeScript)

`fetch`-based ESM client for the Datran core reactor with bundled type declarations and **zero runtime
dependencies**. Works in Node ≥ 20 (tested on Node 24), Deno, Bun and browsers (CORS permitting).

## Install / build

```
cd clients/typescript && npm install && npm run build     # emits dist/ (ESM + .d.ts)
npm install ../clients/typescript                          # from a consuming project
```

## Usage

```ts
import { DatranClient, NotFoundError, RangeNotSatisfiableError } from "@datran/client";
import { openAsBlob, createReadStream, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const c = new DatranClient({ baseUrl: "http://127.0.0.1:3005", token: "secret", timeoutMs: 30_000 });

// Data plane
const r = await c.compress(new TextEncoder().encode('{"a":1}'.repeat(1000)), { contentType: "application/json" });
console.log(r.contentClass, r.recipe, r.format, r.originalSize, r.compressedSize, r.ratio);
const original = await c.decompress(r.data);

// Streaming: ReadableStream / async iterable in, ReadableStream out
const { body, ...meta } = await c.compressStream(Readable.toWeb(createReadStream("big.bin")) as ReadableStream<Uint8Array>, { noSample: true });
const decoded: ReadableStream<Uint8Array> = await c.decompressStream(body);

console.log(await c.entropy("hello"), (await c.evolutionStatus()).classes);

// Object store
const put = await c.storePut(await openAsBlob("video.mp4"), { contentType: "video/mp4" }); // known length, streamed
await c.storePut((async function* () { yield new Uint8Array([1, 2, 3]); })());             // chunked
const part = await c.storeGet(put.file_id, { range: { start: 0, end: 1023 } });            // 206
const tail = await c.storeGet(put.file_id, { range: { suffix: 4096 } });
const s = await c.storeGetStream(put.file_id);
await pipeline(Readable.fromWeb(s.body), createWriteStream("copy.mp4"));
console.log(await c.storeHead(put.file_id), await c.storeStats());
await c.storeDelete(put.file_id); // unpin
```

`RangeSpec` = `"bytes=…"` | `{ start, end? }` (inclusive) | `{ suffix }`. Every method accepts an `AbortSignal`.

## Errors

`DatranError` → `TransportError` (network, timeout, abort, malformed response) and `ApiError` (`status`,
`serverMessage`, `body`, `headers`, `json()`) with subclasses `BadRequestError` (`unknownDict`), `AuthError`,
`NotFoundError`, `MethodNotAllowedError`, `PayloadTooLargeError`, `RangeNotSatisfiableError` (`size`),
`InsufficientStorageError`, `ServerError`.

## Retries and timeouts

`timeoutMs` (default 60 s) is the deadline for receiving response headers; buffered calls also apply it to
the body, streaming calls do not (cancel via `signal`). GET/HEAD are retried on network errors and
429/502/503/504 (`maxRetries` 3, `backoffMs` 200, exponential with jitter); PUT/DELETE/POST never are.
In Node, streamed request bodies use `duplex: "half"` and are sent chunked; pass a `Blob` for a known length.

## Tests

```
npm test                                                   # builds, then node --test
REACTOR_BIN=../../core-reactor/target/release/core-reactor.exe node --test "test/*.test.mjs"
REACTOR_URL=http://127.0.0.1:3005 REACTOR_TOKEN=secret node --test "test/*.test.mjs"
```

`test/unit.test.mjs` is offline (ranges, error mapping, retry policy, timeouts); `test/live.test.mjs` needs a
reactor and skips the store suite while `/store/stats` returns 404.
