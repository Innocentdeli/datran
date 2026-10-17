# Evolutionary Compression — Spec v1

The reactor evolves *compression recipes* (codec + parameters + pre-filter) per content class,
measured on real data with a balanced size/speed objective, and shares good recipes with peer reactors.
Data is always lossless: every encode is verified by decoding before it is returned.

## 1. Blob format v2 (`FLAG_RECIPE = 0x10`)

Legacy flags `0x00`–`0x03` remain decodable forever. New encodes use v2 unless a legacy raw blob
(`0x02` + data) is smaller.

| Offset | Size | Field |
| :--- | :--- | :--- |
| 0 | 1 | `0x10` |
| 1 | 1 | format version = `1` |
| 2 | 1 | codec: `0` raw, `1` lz4, `2` deflate, `3` zstd, `4` brotli, `5` procedural ([NETWORK_SPEC.md §1](NETWORK_SPEC.md)) |
| 3 | 1 | filter: `0` none, `1` delta, `2` shuffle |
| 4 | 1 | filter stride: `1`, `2`, `4` or `8` (`0` when filter = none) |
| 5 | 8 | original length, u64 little-endian |
| 13 | 4 | CRC-32 (IEEE, as zlib `crc32`) of the original bytes, u32 LE |
| 17 | 32 | dictionary id = SHA-256 of the dictionary bytes; all zero = no dictionary (zstd only) |
| 49 | … | payload |

Payload per codec (applied to the *filtered* bytes):
- **raw**: the bytes.
- **lz4**: one LZ4 block (`lz4_flex::block::compress`, no size prefix; decompressed size = original length).
- **deflate**: zlib stream (RFC 1950), i.e. Node `zlib.inflateSync`.
- **zstd**: one standard zstd frame. With a dictionary, compressed with that raw dictionary/trained dict.
- **brotli**: standard brotli stream.
- **procedural**: `varint program_len | program (FILL/REPEAT/ARITH/LITERAL ops) | one zstd frame of the
  literal bytes`; format, decoder rules and encoder in [NETWORK_SPEC.md §1](NETWORK_SPEC.md).

Encode = filter → codec. Decode = codec → unfilter → check length and CRC.

### Filters (stride `s`, length `n`)
- **delta**: `out[i] = in[i]` for `i < s`; `out[i] = in[i] - in[i-s]` (wrapping u8) otherwise.
  Inverse: `in[i] = out[i] + in[i-s]` (wrapping), sequentially.
- **shuffle**: `m = n / s` (integer). For `b in 0..s`, `e in 0..m`: `out[b*m + e] = in[e*s + b]`.
  The tail `in[m*s..n]` is appended unchanged. Inverse accordingly.

### Decoder rules
Reject (error, never panic) if: unknown version/codec/filter, stride not in {1,2,4,8} (or ≠0 with filter none),
filter none with stride ≠ 0, dictionary set on a non-zstd codec, original length > max output
(`REACTOR_MAX_OUTPUT_BYTES`), decoded length ≠ original length, CRC mismatch, or dictionary unknown
(reactor: try fetching from peers first, see §4).

## 2. Recipe (JSON, used in API and gossip)

```json
{ "codec": "zstd", "level": 9, "window_log": 23, "filter": "shuffle", "stride": 4, "dict": "<64 hex>" }
```
- `codec`: `raw` | `lz4` | `deflate` (level 0–9) | `zstd` (level 1–19, `window_log` 10–27 or null) | `brotli` (level 0–11, `window_log` 10–24 or null) | `procedural` (level 1–19 = zstd level of the literal stream, `window_log` null; [NETWORK_SPEC.md §1](NETWORK_SPEC.md))
- `filter`: `none` | `delta` | `shuffle`; `stride` 0 for none, else 1/2/4/8
- `dict`: SHA-256 hex or null (zstd only)

Recipes received from peers are validated against these ranges and otherwise dropped.

## 3. Evolution

- **Content class**: derived from the `x-content-type` hint (mime) plus sniffing (text ratio, magic bytes)
  and entropy bucket, e.g. `text/json`, `text/plain`, `binary/structured`, `media/compressed`.
  High-entropy data (`media/compressed`) short-circuits to raw and is not evolved.
- **Sample reservoir**: per class, up to 32 samples × up to `REACTOR_SAMPLE_BYTES_MAX` (default 1 MiB, a
  prefix of the upload). In memory only — never written to disk. Uploads with header
  `x-reactor-no-sample: 1` are never sampled.
- **Train / held-out split**: each sampled upload gets a per-class upload index `seq` (0, 1, 2, …).
  The split is deterministic: even `seq` = *train*, odd `seq` = *held-out*. A sample keeps its
  side when the reservoir replaces other samples.
- **Fitness** of a recipe = mean over the class's **held-out** reservoir samples of
  `ln(original / compressed) − W_enc · enc_seconds_per_MiB − W_dec · dec_seconds_per_MiB`,
  where each sample is verified lossless (failure ⇒ fitness −∞).
  Defaults `W_enc = 0.5`, `W_dec = 1.0` (`REACTOR_WEIGHT_ENCODE`, `REACTOR_WEIGHT_DECODE`).
  All recipes in a generation (with and without dictionaries) are scored on the same held-out samples.
  Encode timings for fitness are always single-threaded (`Recipe::encode`), so scores stay comparable
  regardless of core count. Multithreading is used only on the request path: `/compress` bodies larger
  than `REACTOR_MT_THRESHOLD` (default 8 MiB; 0 disables) with a zstd champion are encoded with zstd's
  built-in workers (`ZSTD_c_nbWorkers` = `REACTOR_COMPRESS_THREADS`, default all cores). The output is
  still exactly one standard zstd frame with the content size, so blob v2 and all decoders are unchanged
  (only the compressed bytes may differ from a single-threaded encode). Brotli/deflate/lz4/procedural are
  unaffected.
  Only while the held-out split is still empty (a single upload) are recipes scored on the samples
  that no dictionary trained by this process has seen.
- **Population**: per class, 12 recipes, seeded with sensible defaults (zstd 3/9/19, brotli 5/9, lz4,
  deflate 6, zstd 9 + shuffle 4, procedural 3, …). Each generation: score, keep the top 4, fill with crossover
  (codec params from one parent, filter from the other) + mutation (level ±, window ±, filter/stride flip,
  codec switch with low probability), plus any pending immigrants.
- **Dictionaries**: when a class has ≥ 16 samples whose median size < 64 KiB **and ≥ 4 held-out
  samples**, train a zstd dictionary (≤ 110 KiB) from the **train split only** and add dictionary
  variants of the top zstd recipes; they are scored on the held-out split like every other recipe, so a
  dictionary is never judged on data it was trained on. Dictionaries are
  persisted (needed to decode) under `$REACTOR_STATE_DIR/dicts/<sha256>.dict` and never deleted.
- **Scheduling**: evolution runs in a background task (`spawn_blocking`), at most one generation per class
  every `REACTOR_EVOLVE_INTERVAL_MS` (default 30 s) and only when the reservoir changed. Uploads never
  wait for evolution; `/compress` uses the current champion for the class.
- **Persistence**: populations, champions and stats in `$REACTOR_STATE_DIR/state.json`
  (default `./reactor-state`), saved after each generation and on shutdown. `REACTOR_EVOLVE=false`
  freezes evolution (champions still used).
- **Guarantee**: `/compress` verifies the round-trip before responding; if it fails or the output is not
  smaller than legacy raw, it emits legacy raw.

## 4. Network (gossip)

- Peers: `REACTOR_PEERS` = comma-separated base URLs. Auth: header `x-cluster-token` must equal
  `REACTOR_CLUSTER_TOKEN` (constant-time). Without a cluster token, gossip endpoints are disabled.
- Bind: `REACTOR_BIND` (default `127.0.0.1`). Refuse to start on a non-loopback bind unless both
  `REACTOR_TOKEN` and `REACTOR_CLUSTER_TOKEN` are set.
- Every `REACTOR_GOSSIP_INTERVAL_MS` (default 60 s), pull `GET /evolution/champions` from each peer.
  Valid recipes become *immigrants* in the local population and are scored on **local** samples only;
  peer-reported scores are informational and never trusted.
- Dictionaries contain fragments of user data, so they are only served and fetched when
  `REACTOR_SHARE_DICTIONARIES=true` (default false). Recipes that reference a dictionary are not offered
  to peers unless sharing is enabled.
- `/decompress` with an unknown dictionary: if sharing is enabled, fetch it from peers, verify its SHA-256,
  store it, retry; otherwise error.

## 5. HTTP API

| Method | Path | Auth | Purpose |
| :--- | :--- | :--- | :--- |
| GET | `/health` | none | liveness |
| POST | `/compress` | `x-reactor-token` | encode; optional headers `x-content-type`, `x-reactor-no-sample: 1` |
| POST | `/decompress` | `x-reactor-token` | decode legacy and v2 |
| POST | `/entropy` | `x-reactor-token` | entropy of body |
| GET | `/evolution/status` | `x-reactor-token` | per-class generation, champion (recipe, fitness, ratio, enc/dec MiB/s), population size, sample count; weights; peers (url, last ok, last error) |
| GET | `/evolution/champions` | `x-cluster-token` | `[{ "class", "recipe", "fitness" }]` |
| GET | `/evolution/dict/:sha256` | `x-cluster-token` + sharing enabled | dictionary bytes |

`/compress` response headers (in addition to whatever existing headers the app already reads):
`x-reactor-class`, `x-reactor-recipe` (compact JSON), `x-original-size`, `x-compressed-size`.
