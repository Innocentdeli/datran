# Datran Network — Spec v1

Extends [EVOLUTION_SPEC.md](EVOLUTION_SPEC.md). That spec covers recipes, blob format v2 and gossip of recipes;
this one covers the procedural codec, the chunked object store, chunk fusion, data gravity (demand-driven
replication), access prediction, client SDKs and encryption at rest (§7).

Principles: lossless always (every write verified by reading back), content-addressed integrity (SHA-256 everywhere),
crash safety (write new → fsync → atomic index commit → GC old), bounded memory and disk, authenticated cluster
traffic, honest measured metrics only.

---

## 1. Procedural codec (blob v2 codec id `5`)

"Generative compression" made honest: data that is *exactly* produced by a short program (fills, periodic patterns,
counters/arithmetic sequences) is stored as that program. Arbitrary data falls back to literals, compressed with zstd.
Ratios can exceed 32,000× only on genuinely procedural data.

Payload (after the 49-byte v2 header; filters apply as usual before encoding):

```
varint program_len            (LEB128 u64, ≤ 10 bytes)
program[program_len]          (ops, below)
literal_stream                (rest of payload: one zstd frame of the concatenated literal bytes; empty if no literals)
```

Ops (each starts with one byte):
| Op | Encoding | Output |
| :--- | :--- | :--- |
| `0x01` LITERAL | varint `n` | next `n` bytes of the decompressed literal stream |
| `0x02` FILL | varint `n`, u8 `v` | `n` copies of `v` |
| `0x03` REPEAT | varint `p`, varint `n` | `n` bytes, each = output[pos − p] (overlapping copy); requires 1 ≤ p ≤ bytes already output and p ≤ 16 MiB |
| `0x04` ARITH | u8 `w` ∈ {1,2,4,8}, u8 `endian` (0 LE, 1 BE), varint `k`, `w` bytes start (LE), `w` bytes delta (LE) | `k` elements of `w` bytes: `start + i·delta` (wrapping, mod 2^(8w)), each written in `endian` order |

Decoder rules (error, never panic): unknown op; varint overflow/truncation; any op would exceed the header's original
length; total output ≠ original length; LITERAL beyond the literal stream; literal stream has unused trailing bytes;
REPEAT `p` invalid; ARITH `w`/`endian` invalid or `k·w` overflow; program_len beyond payload. Output length is
already capped by `REACTOR_MAX_OUTPUT_BYTES` via the header, so programs cannot become decompression bombs.

Encoder (reactor): single pass detecting, in priority order, FILL runs ≥ 32 bytes, ARITH runs ≥ 16 elements
(w ∈ {1,2,4,8}, both endians), REPEAT with period ≤ 64 KiB covering ≥ 4 periods and ≥ 64 bytes; everything else
becomes LITERAL. Adjacent literals merge. Output is verified by decoding like every other codec.

Recipe: `{"codec":"procedural","level":<zstd level 1–19 for literals>,"window_log":null,"filter":…,"stride":…,"dict":null}`.
It joins the evolution seed pool for every class except `media/compressed`; evolution decides when it wins.
The TypeScript decoder (`src/core/DiocomReactor.ts`) must decode codec 5.

---

## 2. Chunked object store (reactor)

Storage: `$REACTOR_STATE_DIR/store/` — `index.redb` (redb, ACID) + `packs/<pack_id>.pack` (small objects, see
"Pack files") + `objects/<aa>/<sha256>.obj` (objects ≥ the pack threshold).

- **Chunking**: FastCDC (2020), min 16 KiB / avg 64 KiB / max 256 KiB. Chunk id = SHA-256 of plaintext chunk.
- **File id** = SHA-256 of the whole plaintext. A **manifest** = `{ file_id, size, chunks: [{ id, len }], created_ms }`.
- **Objects**: each chunk is stored as a blob-v2 object compressed with the class champion recipe (class from the
  `x-content-type` hint + sniffing of the first chunk). A **super-chunk** object holds several chunks compressed
  together (§3). Object id = SHA-256 of the object's *plaintext* (concatenated member plaintexts).
- **Index tables**: `manifests (file_id → manifest)`, `chunk_loc (chunk_id → object_id, offset, len)`,
  `objects (object_id → stored_len, plain_len, members, refcount, created_ms)`, `pins (file_id → count)`,
  `tombstones (file_id → deleted_ms)`, `access (chunk_id → decayed count, last_ms)`.
- **Dedup**: identical chunks across all files are stored once (refcounted). Stats report logical vs physical bytes.
- **Writes**: stream request body → chunk → for new chunks: compress, verify decode; small objects are appended to the
  active pack file, large ones written as temp file → rename; everything is fsynced, then the index txn commits.
  Duplicate content just increments the pin.
- **Reads**: range-aware. Only objects overlapping the requested range are read and decoded. Every decoded chunk is
  checked against its SHA-256 before bytes are returned.
- **Delete** = unpin. Pin count 0 → tombstone + manifest removed; objects whose refcount reaches 0 are GC'd after
  `REACTOR_GC_GRACE_MS` (default 10 min) so in-flight reads finish.
- **Capacity**: `REACTOR_STORE_MAX_BYTES` (physical). Over capacity: evict cold *replicas* (§4); never evict a file
  that would drop below its replica guarantee; reject new writes with 507 when nothing can be evicted.
- **Integrity scrub**: background task re-verifies a slice of objects per interval; corrupt objects are quarantined
  and re-fetched from a peer if one holds them (§4).

Implementation notes (reactor `src/store/`, refinements of the above):
- The manifest is stored as a header row (`manifests: file_id → size, chunk_count, created_ms, origin, class`)
  plus `manifest_chunks: (file_id, offset) → (chunk_id, len)` so range reads seek without loading the whole
  chunk list. `chunk_loc` also carries `refs` (manifest occurrences); `objects.refcount` counts live
  `chunk_loc` entries pointing at the object and `members` stores `(chunk_id, len)`. Extra tables:
  `gc_queue (object_id → enqueued_ms)`, `quarantine`, `file_log (version → add/remove file_id)` for
  inventory deltas (§4), `meta` (transactional counters). `access` holds two decayed counters per chunk:
  `co` (read in a request together with other chunks) and `solo`.
- Capacity is enforced against *live* physical bytes (objects with refcount > 0, plus in-flight writes);
  objects awaiting GC (≤ grace period) are excluded, so dropping/evicting a file frees admission immediately.
  The default eviction policy never evicts a pinned origin file; data gravity installs its own.
- A `Range` header with several ranges is ignored (200, full body), as RFC 9110 permits.
- GC never deletes an object that an in-flight read/write/fusion has reserved (in-memory reservation of
  chunk/object ids taken before the index lookup), in addition to the grace period.
- Fusion/unfusion hysteresis: a run whose chunks are mostly read individually is never fused.
- Group commit: concurrent uploads hand their index changes to a leader that commits them in ONE redb transaction
  (`REACTOR_GROUP_COMMIT_MS`, default 2 ms window, only while other writers are still staging).
- Multi-core ingest: `REACTOR_COMPRESS_THREADS` (default = all logical cores; capped at
  `available_parallelism`; `1` = sequential inline compression) sizes ONE process-wide compression pool shared by
  all uploads (no oversubscription under many concurrent uploads). Per upload, the request thread chunks, hashes
  and decides each chunk in order (in-file dedup → reservation → index lookup), new chunks are compressed on the
  pool, and a stager thread admits/stages the results strictly in chunk order, so on-disk format, manifest,
  object/pack layout and `PutOutcome` counts are byte-identical to sequential mode.
  `REACTOR_INGEST_INFLIGHT_BYTES` (default 64 MiB, min 256 KiB) caps the plaintext bytes per upload that are
  between chunker and stager (encoded results add at most the same again). `/store/stats` → `ingest`
  reports `compress_threads`, `pool_threads`, `inflight_cap_bytes`, `inflight_peak_bytes`, `pool_chunks`.

### Pack files (small objects)

Objects whose *stored* size is < `REACTOR_PACK_THRESHOLD` (default 128 KiB; 0 disables packing) are appended to the
active pack `packs/<pack_id as 16 hex digits>.pack` instead of getting a file each (git packfiles / Haystack style).
Larger objects keep the per-file layout. The stored bytes are the same blob-v2 object either way.

```
pack header (16 B):  magic "DTRPACK1" (8) | pack_id u64 LE
record:              magic u32 LE = "REC1" | object_id [32] | len u32 LE | crc32 u32 LE | payload[len]
                     crc32 = CRC-32/IEEE over object_id ‖ len (LE) ‖ payload; payload = blob-v2 object,
                     or its encryption envelope when a master key is configured (§7)
```

Packs are append-only and self-describing (a pack can be scanned record by record without the index).
- **Index**: `objects` rows gain an optional location: flag bit `2` (packed) plus a trailer `pack_id u64, offset u64`
  (offset of the record header). Rows without the flag — every row written before packs existed — are file objects,
  so existing indexes migrate transparently (the `packs` table is created empty on open).
  `packs (pack_id → end u64, live_bytes u64, live_objects u64)`: `end` = committed length of the pack;
  `live_*` = records of indexed objects located in it (record size = 44 + len). Dead bytes = `end − 16 − live_bytes`.
- **Writes**: writers keep small objects in memory (≤ 16 MiB per upload; beyond that they append + fsync early,
  unindexed). The group-commit leader appends every job's records with ONE write, ONE fsync of the pack, then ONE redb
  commit, so N concurrent small uploads cost one fsync + one commit. A PUT is acknowledged only after its pack bytes
  were fsynced and its index txn committed (unchanged durability). Every txn that indexes a record also raises the
  pack's `end` to cover it. The active pack is sealed at `REACTOR_PACK_MAX_BYTES` (default 256 MiB); a new one starts.
- **Crash recovery**: on startup each pack is truncated to its committed `end` (torn / uncommitted tail); pack files
  without a `packs` row are deleted (crash before their first commit, or a compacted pack awaiting deletion).
  Records below `end` that no index row references are garbage (dead bytes), never errors.
- **Reads**: positional reads through a bounded cache of open pack handles (64). Each read checks magic, object id,
  length and CRC, then the usual blob decode + SHA-256. If a read fails because the object moved (compaction /
  repair), the location is re-resolved and the read retried, so in-flight reads never fail spuriously.
- **GC / compaction**: collecting a packed object only decrements its pack's live counters. After each GC run,
  every *sealed* pack whose live bytes < 50 % of its data (or that has no live records) is compacted: live records
  are copied into the active pack (fsync) → one index txn repoints each object still at its old location → the pack's
  row is removed once it has no live records → the file is deleted after `REACTOR_GC_GRACE_MS`. Appends pin the packs
  they touched until their index txn finished and only the active pack receives appends, so a pack with uncommitted
  records is never retired. A crash at any point leaves a consistent index.
- **Scrub / quarantine / repair**: scrub verifies packed objects like file objects (plus the record CRC). Quarantine of
  a packed object unlinks its record (dead bytes; a copy of the bad bytes goes to `quarantine/`); repair writes a
  fresh record (or file, if large) and repoints the object. `GET /cluster/objects/:id`, replica import and peer
  repair work unchanged on packed objects.
- **Stats**: `/store/stats` → `packs`: `{enabled, threshold_bytes, max_pack_bytes, compact_live_ratio, packs,
  sealed_packs, active_pack, packed_objects, bytes, live_bytes, dead_bytes, compactions, compaction_moved_objects,
  compaction_reclaimed_bytes, retired_pending_delete, open_handles, appends, fsyncs, rotations,
  startup_truncated_bytes, startup_removed_packs}`.

### Store HTTP API (auth `x-reactor-token`)
| Method | Path | Notes |
| :--- | :--- | :--- |
| PUT | `/store/files` | body = file; headers `x-content-type`, `x-reactor-no-sample`. Returns `{file_id,size,stored_bytes,new_bytes,new_chunks,dedup_chunks,chunks,class,duplicate,pins}`; `new_bytes` = plaintext bytes of the chunks newly stored by this upload (0 when duplicate), so its compression = `new_bytes / stored_bytes` |
| GET | `/store/files/:file_id` | full file or `Range: bytes=…` (single range, suffix ranges, 416 when unsatisfiable); streams the response |
| HEAD | `/store/files/:file_id` | size, `Accept-Ranges` |
| DELETE | `/store/files/:file_id` | unpin |
| GET | `/store/stats` | logical/physical bytes, dedup ratio, objects, super-chunks, fusion gains, GC queue, scrub status, packs, encryption (§7) |
| POST | `/store/rekey` | re-encrypt under the active key (§7); returns a rekey report |

---

## 3. Chunk fusion (self-rewriting storage)

Background task that rewrites the store layout based on evidence:

- **Signals**: (a) *structural* — chunk sequences `c_i, c_{i+1}, …` that appear consecutively in ≥ 2 manifests;
  (b) *access* — chunks read within the same request ≥ `REACTOR_FUSE_COACCESS_MIN` (default 8) times (decayed).
- **Candidate** = maximal run of such chunks, total plaintext ≤ 4 MiB, currently in ≥ 2 objects.
- **Accept** only if compressing the run together (class champion recipe) is ≥ 5 % smaller than the sum of the
  current objects, *or* the run was co-accessed (fewer reads) and is no larger than the current sum.
- **Rewrite**: write super-chunk object (verify, fsync) → single index txn repoints `chunk_loc` for every member and
  adjusts refcounts → old objects GC'd after grace. Crash at any point leaves a consistent index.
- **Unfuse**: if a super-chunk's members are mostly read individually (access signal) and it is > 1 MiB, it may be
  split back. Metrics: fusions, bytes saved, reads saved.

---

## 4. Data gravity (demand-driven replication)

Nodes: each reactor has a stable `node_id` (random, persisted) and optional `REACTOR_REGION`. Peers from
`REACTOR_PEERS`, authenticated with `x-cluster-token`. Optional TLS: `REACTOR_TLS_CERT`/`REACTOR_TLS_KEY` (server)
and `REACTOR_TLS_CA` (trust for peers).

- **Inventory gossip** (every `REACTOR_GOSSIP_INTERVAL_MS`): `GET /cluster/inventory?since=<version>` returns
  `{ node_id, region, version, capacity, used, added:[file_id], removed:[file_id], tombstones:[{file_id,deleted_ms}],
  demand:[{file_id, score}] }` (delta since version; full when `since` is unknown). Each node keeps
  `holders: file_id → {node_id}` and peer demand.
- **Remote read**: GET of a file not held locally → fetch manifest (`GET /cluster/manifests/:file_id`) and needed
  objects (`GET /cluster/objects/:object_id`, raw stored blob) from holders, verify every chunk hash, serve. Fetched
  objects go into a bounded local cache, not the store.
- **Gravity pull**: each node tracks per-file demand (exponentially decayed request count, half-life
  `REACTOR_DEMAND_HALFLIFE_MS`, default 1 h). When a non-held file's local demand ≥ `REACTOR_GRAVITY_PULL` (default
  3), the node pulls a full replica (manifest + objects, dedup applies). Data moves to where it is requested.
- **Gravity drop**: a held replica with near-zero local demand that is in demand elsewhere may be dropped only if
  ≥ `REACTOR_MIN_REPLICAS` (default 2, capped at cluster size) *other* nodes hold it, confirmed by acquiring
  hold-leases: `POST /cluster/hold/:file_id` → holder promises not to drop for 10 min. No lease, no drop.
  The node where a file was first written never drops it while pins > 0 unless another node accepted origin
  transfer via the same lease mechanism.
- **Repair**: files with fewer than `REACTOR_MIN_REPLICAS` holders are pulled by the healthy node with the most free
  capacity (deterministic tie-break by node_id) so concurrent repairs don't stampede.
- **Deletes**: tombstones propagate via inventory; every holder deletes the file; tombstones kept 30 days; a tombstone
  beats any replica with an older `created_ms`.
- **Cluster endpoints** (auth `x-cluster-token`): `/cluster/inventory`, `/cluster/manifests/:id`,
  `/cluster/objects/:id`, `POST /cluster/hold/:id`. Response size caps and timeouts on every fetch.
- **Metrics** in `/store/stats` and `/cluster/status` (auth `x-reactor-token`): holders per file (sampled), pulls,
  drops, repairs, remote-read bytes, per-peer health.

Implementation notes (reactor `src/cluster/`, refinements of the above):
- `node_id` lives in `$REACTOR_STATE_DIR/node_id`; granted leases in `$REACTOR_STATE_DIR/cluster-leases.json`
  (respected across restarts). Gravity is enabled when the store is on and `REACTOR_CLUSTER_TOKEN` is set.
- Inventory: `GET /cluster/inventory?since=<version>&tsince=<ms>` also returns `full` (added = complete list),
  `more` (page of 10 000 events; resume from `version`) and `now_ms`. A delta carries tombstones with
  `deleted_ms ≥ tsince` plus the tombstones of its `removed` events; full listings (first contact, unknown or
  future `since`, peer identity change, and every 30th fetch) carry all tombstones. A peer is *healthy* when its
  last inventory fetch succeeded and is younger than 3 × interval.
- `GET /cluster/manifests/:id` returns `{file_id,size,created_ms,origin,chunks:[{id,len,object_id,object_offset}],
  objects:[{object_id,stored_len,plain_len,members:[{id,len}]}]}` (where the holder keeps each chunk), validated
  structurally by the receiver. Extra endpoints: `GET /cluster/chunks/:id` (verified plaintext, used to repair
  a quarantined object when no peer has the same object) and `POST /cluster/unpin/:id` (a DELETE for a file the
  node does not hold is forwarded to the holder that owns origin — after an origin transfer the pins live there).
- Remote reads try known holders first, then every other peer (inventory lags fresh uploads); responses carry
  `x-reactor-remote: 1`. Manifests older than a local tombstone are refused (404), so are such pulls.
- Pull threshold: demand ≥ `REACTOR_GRAVITY_PULL` − 0.005 (N quick requests decay to slightly under N).
- Drop: "near-zero local demand" = below `REACTOR_GRAVITY_DROP_BELOW` (default 0.5); "in demand elsewhere" = a
  healthy peer advertises demand ≥ 1. Needed leases = `min(REACTOR_MIN_REPLICAS, cluster size)` *other* holders
  (so a 2-node cluster with the default 2 never drops). `POST /cluster/hold/:id?node=<id>[&origin=1&pins=N]`
  returns `{file_id,node_id,granted,expires_ms,lease_ms,origin_accepted,reason}`; it is refused when the file is
  not held or the holder is dropping it. Origin is requested only after all needed plain leases were granted;
  the accepting holder becomes origin and adds the pins. A node never drops or evicts a file it leased out.
- Repair target = `min(REACTOR_MIN_REPLICAS, healthy cluster size)`; leader = healthy non-holder with the most free
  capacity (`max_bytes − used`, unlimited = max), ties → smallest `node_id`; at most 32 pulls per round.
- Eviction (store over capacity): the gravity policy offers cold replicas (lowest local demand first) only after the
  needed leases were granted *now*; pinned origin files and leased-out files are never evicted; otherwise 507.
- Caps: inventory/manifest 64 MiB, object 16 MiB + 64 KiB, chunk 16 MiB; client timeout 30 s (connect 5 s), no
  redirects. `REACTOR_TLS_CA` replaces the built-in roots for peer connections.
- Extra env: `REACTOR_GRAVITY_DROP_BELOW`, `REACTOR_REMOTE_CACHE_BYTES` (default 256 MiB, decoded objects, LRU).
- Encryption at rest (§7): `GET /cluster/objects/:id` returns the object's *transport form* — its blob v2,
  decrypted and verified (AEAD + decode + SHA-256) but still compressed — never the local envelope. Receivers
  verify it as before and re-seal it under their own active key (replica import, peer repair), so nodes may
  use different master keys. Protect cluster traffic with `REACTOR_TLS_*` when it crosses untrusted networks.

---

## 5. Access prediction & prefetch (web app)

Real version of "temporal precognition": predict downloads and have them ready before they are requested.

- **Events**: each successful stream request records `(file_id, ts, actor)` where actor = session user id or a
  salted hash of IP + UA (salt = app secret; raw IPs never stored). Bounded retention
  (`PREDICT_RETENTION_DAYS`, default 30).
- **Models** (combined score per file):
  1. *Recency/frequency*: decayed request count.
  2. *Temporal*: per-file histogram over hour-of-week (168 bins, decayed) → probability of access in the next window.
  3. *Sequential*: first-order Markov transitions file A → file B per actor sequence (within 30 min), decayed.
- **Prefetch**: (a) every `PREFETCH_INTERVAL_MS` warm the top predicted files for the next window into the stream
  cache within `PREFETCH_MAX_BYTES` (a share of `STREAM_CACHE_MAX_BYTES`); (b) on each access, warm the top-k Markov
  successors. Password-protected files are warmed (bytes only) but access checks still apply on serve.
  With the reactor store, prefetch also issues a reactor read so gravity sees the demand.
- **Metrics**: prediction precision/recall over a rolling window, cache hit rate for predicted vs unpredicted
  requests, measured server time saved (p50/p95 time-to-first-byte cold vs warm). Shown in admin.

---

## 6. Polyglot SDKs

- `core-reactor/openapi.yaml` (OpenAPI 3.1) describes every reactor endpoint (data plane + evolution + store; cluster
  endpoints documented as internal).
- Clients in `clients/`: **Python** (`clients/python`, stdlib only, typed, streaming upload/download, ranges),
  **Rust** (`clients/rust`, reqwest), **C++** (`clients/cpp`, C++17, header-only, no external deps: minimal
  HTTP/1.1 over sockets for Windows and POSIX), **TypeScript** (`clients/typescript`, fetch-based).
- Each client ships tests that run against a live reactor (start the release binary on an ephemeral port) covering
  compress/decompress, store put/get/range/delete and status, plus a README with examples.

---

## 7. Encryption at rest (reactor)

Everything the reactor persists that contains user bytes is sealed with an AEAD: store objects (file layout and
pack records) and zstd dictionaries (`dicts/`, trained on uploads). Not encrypted, and verified to hold no user
content: `index.redb` (ids = SHA-256 hashes, lengths, counters, pack locations; file names are never sent to the
reactor), `state.json` (recipes, scores, dictionary ids; samples are never persisted), `node_id`,
`cluster-leases.json`. `quarantine/` keeps the stored (sealed) bytes of corrupt objects.

**Keys** (environment, read at startup):
| Variable | Meaning |
| :--- | :--- |
| `REACTOR_MASTER_KEY` | one 32-byte master key: 64 hex digits or base64 (standard / URL-safe, padding optional); key id = `REACTOR_ACTIVE_KEY_ID` or `default` |
| `REACTOR_MASTER_KEY_FILE` | file holding such a key, or `id:key` entries (comma / newline separated) |
| `REACTOR_MASTER_KEYS` | `id1:key1,id2:key2` for rotation; ids are 1–32 chars of `[A-Za-z0-9._-]` |
| `REACTOR_ACTIVE_KEY_ID` | key id for new writes (required when several keys are configured) |
| `REACTOR_REQUIRE_ENCRYPTION` | `true` → refuse to start without a key |

No key configured → the reactor runs unencrypted (development) and logs a prominent warning. A malformed key,
duplicate id, unknown active id or ambiguous key set refuses to start (exit 2). Reads work with any configured
key; a sealed item whose key id is not configured is an error (`503` on HTTP, `KeyUnavailable` in the library,
counted as `unverifiable` by scrub, listed in `encryption.missing_key_ids`) — never treated as plaintext and
never quarantined. Legacy plaintext items (written before a key was configured) stay readable.

**Algorithm**: AES-256-GCM-SIV (RFC 8452, nonce-misuse resistant; RustCrypto, pure Rust with AES-NI / CLMUL
autodetection). Per-item key = `HKDF-SHA256(ikm = master key, salt = item id, info = "datran-obj-v1")`
(`"datran-dict-v1"` for dictionaries, salt = dictionary id); random 96-bit nonce per seal.

```
envelope: magic "DTE1" (4) | kind u8 (1 object, 2 dictionary) | key_id_len u8 | key_id | nonce [12] | ciphertext | tag [16]
AAD     = magic ‖ kind ‖ key_id_len ‖ key_id ‖ item id [32]
plaintext of an object envelope = the blob-v2 object (compressed); of a dictionary envelope = the dictionary
```

The AAD binds format version, kind, key id and item id: an envelope copied to another object id, relabelled with
another key id or tampered with fails its tag. Blob v2 starts with `0x10`, never `D`, so plaintext and sealed items
are told apart without a flag. Envelope overhead: 34 bytes + key id length per object.

**Integrity is unchanged**: ids are SHA-256 of the plaintext; every read decrypts (tag check), decodes (CRC) and
verifies chunk / object hashes as before; pack records keep their CRC over the sealed payload. Scrub verifies the
AEAD tag and the plaintext hash; a tag failure quarantines the object and data gravity repairs it from a peer.
A file object's length may differ from its index row after a crash between "rename rewritten file" and "index
commit": scrub accepts it if the content verifies and startup adopts the file's length and key.

**Index bookkeeping**: `objects.flags` bits 2–7 hold the *key slot* the stored bytes are sealed under (0 =
plaintext, which every pre-encryption row decodes as); `meta` maps `key_slot:<key id> → slot` (1–63, allocated
when a key id is first used as active) and keeps transactional counters `enc_objects:<slot>` (initialised by one
index scan on the first open after upgrade, maintained by insert / GC / rewrite, checked by `verify_index`).
`/store/stats` → `encryption: {enabled, algorithm, active_key_id, configured_key_ids, objects_by_key,
plaintext_objects, missing_key_ids, dictionaries: {by_key, plaintext}}`.

**Writes**: chunks are compressed, verified and sealed on the compression pool (encryption scales with
`REACTOR_COMPRESS_THREADS`); fusion, unfusion, repair and replica import seal under the active key.

**Cluster** (§4): objects travel in transport form (blob v2, decrypted but compressed) and are re-sealed by the
receiver, so every node can have its own master key and key rotation is per node. Use TLS between nodes.

**Migration and key rotation**: `reactor-admin rekey` (offline; the reactor must be stopped because the index is
opened exclusively) or `POST /store/rekey` (online). Both walk the index (key slot ≠ active slot → candidate),
read + open + verify each object, seal it under the active key and install the new copy (new pack record or
atomically replaced file, then one index transaction that repoints the row only if the object did not change
meanwhile). Crash-safe at every step and resumable — rerun to continue; already-converted objects cost one index
row read. Afterwards the active pack is sealed and every pack with dead records (the superseded plaintext /
old-key copies) is compacted, and dictionary files are rewrapped. Progress is printed (`reactor-admin`) and the
report lists `encrypted`, `rewrapped`, `skipped`, `failed`, `remaining`. Rotation: add the new key to
`REACTOR_MASTER_KEYS`, make it active, restart, rekey, then remove the old key once `remaining` is 0
(`reactor-admin status` prints the encryption stats, `reactor-admin verify` runs a deep fsck).

**Measured overhead** (store-bench, 1 GiB generated mixed data as one upload, 14 threads, 3 runs each, Windows):
ingest plain 139 / 254 / 162 MiB/s vs encrypted 142 / 193 / 211 MiB/s; verified read-back plain 293 / 300 / 387
MiB/s vs encrypted 373 / 337 / 303 MiB/s — run-to-run noise exceeds the difference. Stored bytes +0.11 %
(455.83 → 456.32 MiB for 13 154 objects). Single-core AEAD incl. key derivation and copies (64 KiB objects):
seal ≈ 530 MiB/s, open ≈ 1.5 GiB/s.
