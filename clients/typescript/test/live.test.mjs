import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { openAsBlob, writeFileSync, rmSync, mkdtempSync, createWriteStream, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AuthError,
  BadRequestError,
  ClusterAdmin,
  DatranClient,
  NotFoundError,
  RangeNotSatisfiableError,
  ServerError,
} from "../dist/index.js";
import { startCluster, startReactor } from "./harness.mjs";

const reactor = await startReactor();
const skip = reactor ? false : "no reactor: set REACTOR_BIN or REACTOR_URL";

function sampleText(lines = 5000) {
  let s = "";
  for (let i = 0; i < lines; i++) s += `{"id":${i},"name":"user${i}","ok":${i % 3 === 0}}\n`;
  return new TextEncoder().encode(s);
}

const sha = (b) => createHash("sha256").update(b).digest("hex");
const concat = async (stream) => new Uint8Array(await new Response(stream).arrayBuffer());

after(async () => {
  await reactor?.stop();
});

describe("data plane", { skip }, () => {
  /** @type {DatranClient} */
  let c;
  before(() => {
    c = new DatranClient({ baseUrl: reactor.url, token: reactor.token, timeoutMs: 30_000 });
  });

  test("health", async () => {
    const h = await c.health();
    assert.equal(h.status, "online");
    assert.ok(Array.isArray(h.features));
  });

  test("compress/decompress round trip", async () => {
    const data = sampleText();
    const r = await c.compress(data, { contentType: "application/json" });
    assert.equal(r.originalSize, data.length);
    assert.equal(r.compressedSize, r.data.length);
    assert.ok(r.compressedSize < data.length);
    assert.equal(r.format, "v2");
    assert.ok(r.recipe && typeof r.recipe.codec === "string");
    assert.ok(r.contentClass.length > 0);
    assert.ok(r.ratio > 1);
    assert.deepEqual(await c.decompress(r.data), data);
  });

  test("streaming compress/decompress", async () => {
    const data = sampleText(20000);
    const src = new ReadableStream({
      start(ctrl) {
        for (let i = 0; i < data.length; i += 10000) ctrl.enqueue(data.subarray(i, i + 10000));
        ctrl.close();
      },
    });
    const r = await c.compressStream(src, { noSample: true });
    const blob = await concat(r.body);
    assert.equal(blob.length, r.compressedSize);
    async function* gen() {
      yield blob.subarray(0, 100);
      yield blob.subarray(100);
    }
    const out = await concat(await c.decompressStream(gen()));
    assert.deepEqual(out, data);
  });

  test("empty and incompressible input", async () => {
    const e = await c.compress(new Uint8Array());
    assert.equal((await c.decompress(e.data)).length, 0);
    const rnd = randomBytes(50_000);
    const r = await c.compress(rnd);
    assert.equal(r.contentClass, "media/compressed");
    assert.equal(r.recipe, null);
    assert.equal(r.format, "legacy-raw");
    assert.deepEqual(await c.decompress(r.data), new Uint8Array(rnd));
  });

  test("decompress garbage -> BadRequestError", async () => {
    await assert.rejects(c.decompress(new TextEncoder().encode("\x67garbage")), (e) => {
      assert.ok(e instanceof BadRequestError);
      assert.equal(e.status, 400);
      assert.match(e.serverMessage, /flag/i);
      return true;
    });
  });

  test("entropy", async () => {
    const e = await c.entropy("hello");
    assert.equal(e.size_bytes, 5);
    assert.ok(Math.abs(e.entropy_bits - 1.92) < 0.01);
    assert.equal(e.suggested_routing, "symbit");
  });

  test("evolution status", async () => {
    await c.compress(sampleText(100), { contentType: "application/json" });
    const s = await c.evolutionStatus();
    for (const k of ["enabled", "interval_ms", "weights", "classes"]) assert.ok(k in s, k);
    assert.ok(Array.isArray(s.classes));
  });

  test("bad token -> AuthError", { skip: reactor && !reactor.token ? "reactor without token" : false }, async () => {
    const bad = new DatranClient({ baseUrl: reactor.url, token: "wrong-token" });
    await assert.rejects(bad.entropy("x"), (e) => e instanceof AuthError && e.status === 401);
    assert.equal((await bad.health()).status, "online");
  });
});

let storeSkip = skip;
if (!skip) {
  try {
    await new DatranClient({ baseUrl: reactor.url, token: reactor.token }).storeStats();
  } catch (e) {
    if (e instanceof NotFoundError) storeSkip = "store not available on this reactor (/store/stats -> 404)";
    else if (e instanceof ServerError && e.status === 503) storeSkip = "object store disabled (/store/stats -> 503)";
    else throw e;
  }
}

describe("store", { skip: storeSkip }, () => {
  /** @type {DatranClient} */
  let c;
  let dir;
  before(() => {
    c = new DatranClient({ baseUrl: reactor.url, token: reactor.token, timeoutMs: 60_000 });
    dir = mkdtempSync(join(tmpdir(), "datran-ts-files-"));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  test("put / get / range / head / delete", async () => {
    const data = new Uint8Array(Buffer.concat([sampleText(30000), randomBytes(100_000)]));
    const fid = sha(data);
    const put = await c.storePut(data, { contentType: "application/json" });
    assert.equal(put.file_id, fid);
    assert.equal(put.size, data.length);
    assert.equal(put.duplicate, false);
    assert.equal(put.pins, 1);
    assert.ok(put.chunks > 0);
    assert.equal(put.new_chunks + put.dedup_chunks, put.chunks);
    assert.ok(put.stored_bytes > 0);
    assert.ok(put.new_bytes > 0 && put.new_bytes <= put.size);
    assert.equal(typeof put.class, "string");
    assert.ok(put.class.length > 0);
    let deleted;
    try {
      const full = await c.storeGet(fid);
      assert.equal(full.status, 200);
      assert.deepEqual(full.data, data);
      assert.equal(full.etag, `"${fid}"`);

      const h = await c.storeHead(fid);
      assert.equal(h.size, data.length);
      assert.equal(h.acceptRanges, "bytes");
      assert.equal(h.etag, `"${fid}"`);
      assert.equal(await c.storeExists(fid.toUpperCase()), true);

      const multi = await c.storeGet(fid, { range: "bytes=0-1,4-5" }); // multi-range -> whole file
      assert.equal(multi.status, 200);
      assert.deepEqual(multi.data, data);

      const g = await c.storeGet(fid, { range: { start: 1000, end: 1999 } });
      assert.equal(g.status, 206);
      assert.deepEqual(g.data, data.subarray(1000, 2000));
      assert.deepEqual([g.start, g.end, g.total], [1000, 1999, data.length]);
      assert.deepEqual((await c.storeGet(fid, { range: { suffix: 777 } })).data, data.subarray(data.length - 777));
      assert.deepEqual((await c.storeGet(fid, { range: { start: data.length - 10 } })).data, data.subarray(data.length - 10));
      await assert.rejects(c.storeGet(fid, { range: { start: data.length + 10 } }), (e) => {
        assert.ok(e instanceof RangeNotSatisfiableError);
        assert.equal(e.status, 416);
        assert.equal(e.size, data.length);
        return true;
      });

      const out = join(dir, "dl.bin");
      const s = await c.storeGetStream(fid);
      await pipeline(Readable.fromWeb(s.body), createWriteStream(out));
      assert.equal(sha(readFileSync(out)), fid);
    } finally {
      deleted = await c.storeDelete(fid);
    }
    assert.deepEqual(deleted, { file_id: fid, pins: 0, deleted: true });
    await assert.rejects(c.storeGet(fid), NotFoundError);
    assert.equal(await c.storeExists(fid), false);
    await assert.rejects(c.storeDelete(fid), NotFoundError);
  });

  test("put from file (Blob, known length), chunked stream, dedup, pins", async () => {
    // a per-run tag on every line keeps every chunk unique, so the first put stores all of it
    const tag = `"${randomBytes(4).toString("hex")}-user`;
    const data = new TextEncoder().encode(new TextDecoder().decode(sampleText(8000)).replaceAll('"user', tag));
    const fid = sha(data);
    const p = join(dir, "up.json");
    writeFileSync(p, data);
    const a = await c.storePut(await openAsBlob(p));
    async function* chunks() {
      yield data.subarray(0, 5000);
      yield data.subarray(5000);
    }
    const b = await c.storePut(chunks());
    assert.equal(a.file_id, fid);
    assert.equal(b.file_id, fid);
    assert.equal(b.new_chunks, 0);
    assert.ok(b.dedup_chunks > 0);
    assert.equal(b.dedup_chunks, b.chunks);
    assert.equal(b.duplicate, true);
    assert.deepEqual([a.pins, b.pins], [1, 2]);
    // new_bytes: plaintext of newly stored chunks; compression = new_bytes / stored_bytes
    assert.deepEqual([a.new_chunks, a.new_bytes], [a.chunks, data.length]);
    assert.ok(a.new_bytes > a.stored_bytes, "JSON lines compress");
    assert.deepEqual([b.new_bytes, b.stored_bytes], [0, 0]);
    assert.deepEqual(await c.storeDelete(fid), { file_id: fid, pins: 1, deleted: false }); // one pin left
    assert.deepEqual((await c.storeGet(fid)).data, data);
    assert.deepEqual(await c.storeDelete(fid), { file_id: fid, pins: 0, deleted: true });
    await assert.rejects(c.storeHead(fid), NotFoundError);
  });

  test("stats and unknown id", async () => {
    const expected = {
      top: ["files", "logical_bytes", "unique_bytes", "physical_bytes", "live_physical_bytes", "dedup_ratio",
        "compression_ratio", "total_ratio", "objects", "super_chunks", "chunks", "tombstones", "inventory_version",
        "inflight_bytes", "puts", "put_bytes", "reads", "read_bytes", "full_rejections", "evictions"],
      gc: ["queue_objects", "queue_bytes", "grace_ms", "collected_objects", "collected_bytes",
        "startup_orphans_removed", "startup_temp_files_removed"],
      fusion: ["fusions", "unfusions", "bytes_saved", "reads_saved", "candidates_evaluated", "rejected",
        "last_run_ms", "access_rows", "coaccess_min"],
      scrub: ["objects_checked", "bytes_checked", "corrupt_found", "passes_completed", "pass_progress_objects",
        "last_step_ms", "last_pass_ms", "quarantined"],
    };
    const before = await c.storeStats();
    const small = sampleText(3000);
    const p = await c.storePut(small);
    try {
      const s = await c.storeStats();
      for (const k of expected.top) assert.equal(typeof s[k], "number", k);
      for (const g of ["gc", "fusion", "scrub"]) for (const k of expected[g]) assert.equal(typeof s[g][k], "number", `${g}.${k}`);
      assert.equal(typeof s.fusion.enabled, "boolean");
      assert.equal(s.max_bytes, null);
      assert.ok(s.files >= 1 && s.puts > before.puts);
      assert.ok(s.logical_bytes >= small.length && s.unique_bytes > 0 && s.live_physical_bytes > 0);
      assert.ok(s.dedup_ratio >= 1 && s.gc.grace_ms > 0);
      assert.ok(s.group_commit && s.group_commit.jobs >= 1 && typeof s.group_commit.window_ms === "number");
      assert.equal(s.cluster, undefined); // single reactor without REACTOR_CLUSTER_TOKEN
      const nc = new DatranClient({ baseUrl: reactor.url, token: reactor.token, maxRetries: 0 });
      await assert.rejects(nc.clusterStatus(), (e) => e instanceof ServerError && e.status === 503);
    } finally {
      await c.storeDelete(p.file_id);
    }
    await assert.rejects(c.storeGet("0".repeat(64)), NotFoundError);
    await assert.rejects(c.storeGet("not-a-sha256"), BadRequestError);
  });
});

const cluster = skip ? null : await startCluster(2, 200);
const clusterSkip = cluster ? false : "cluster tests need REACTOR_BIN";

after(async () => {
  await cluster?.stop();
});

async function waitFor(pred, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let v;
  while (Date.now() < deadline) {
    v = await pred();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return v;
}

describe("cluster (2 nodes)", { skip: clusterSkip }, () => {
  /** @type {DatranClient} */
  let a;
  /** @type {DatranClient} */
  let b;
  before(() => {
    a = new DatranClient({ baseUrl: cluster.urls[0], token: cluster.token, timeoutMs: 30_000 });
    b = new DatranClient({ baseUrl: cluster.urls[1], token: cluster.token, timeoutMs: 30_000 });
  });

  const healthy = async (c, peerId) => {
    const s = await c.clusterStatus();
    return s.peers.find((p) => p.node_id === peerId)?.healthy ? s : null;
  };

  test("status shows the peer healthy; put on A, read and delete via B", async () => {
    const aId = (await a.clusterStatus()).node_id;
    const bId = (await b.clusterStatus()).node_id;
    assert.notEqual(aId, bId);
    const sa = await waitFor(() => healthy(a, bId));
    assert.ok(sa, "A never saw B healthy");
    assert.ok(await waitFor(() => healthy(b, aId)), "B never saw A healthy");
    assert.deepEqual([sa.cluster_size, sa.min_replicas, sa.min_replicas_effective, sa.gossip_interval_ms], [2, 1, 1, 200]);
    assert.equal(sa.tls, false);
    const pb = sa.peers.find((p) => p.node_id === bId);
    assert.equal(pb.url, cluster.urls[1]);
    assert.equal(pb.is_self, false);
    assert.equal(pb.consecutive_failures, 0);
    assert.equal(typeof pb.last_ok_ms, "number");
    assert.ok(sa.metrics.gossip_rounds >= 1);

    const data = new Uint8Array(Buffer.concat([sampleText(4000), randomBytes(20_000)]));
    const fid = sha(data);
    assert.equal((await a.storePut(data)).file_id, fid);
    let d;
    try {
      const g = await b.storeGet(fid); // B does not hold it -> remote read from A
      assert.deepEqual(g.data, data);
      assert.equal(g.headers.get("x-reactor-remote"), "1");
      assert.deepEqual((await b.storeGet(fid, { range: { start: 100, end: 199 } })).data, data.subarray(100, 200));
      const st = await b.storeStats();
      assert.ok(st.cluster && st.cluster.remote_reads >= 1 && st.cluster.remote_read_bytes > 0);
      const hs = (await a.clusterStatus()).holders_sample.find((h) => h.file_id === fid);
      assert.ok(hs && hs.local && hs.holders.includes(aId));
    } finally {
      d = await b.storeDelete(fid); // forwarded to A (origin)
    }
    assert.deepEqual(d, { file_id: fid, pins: 0, deleted: true, forwarded_to: aId });
    assert.ok((await b.storeStats()).cluster.unpins_forwarded >= 1);
    await assert.rejects(a.storeGet(fid), NotFoundError);
  });

  test("ClusterAdmin inventory + hold", async () => {
    const adm = new ClusterAdmin({ baseUrl: cluster.urls[0], clusterToken: cluster.clusterToken });
    const put = await a.storePut(sampleText(1500));
    try {
      const inv = await adm.inventory();
      assert.equal(inv.full, true);
      assert.ok(inv.added.includes(put.file_id));
      assert.equal(inv.node_id, (await a.clusterStatus()).node_id);
      const delta = await adm.inventory({ since: inv.version, tsince: inv.now_ms });
      assert.equal(delta.version, inv.version);
      assert.equal(delta.full, false);
      assert.deepEqual(delta.added, []);
      const h = await adm.hold(put.file_id, "sdktest");
      assert.equal(h.granted, true);
      assert.ok(h.expires_ms > 0);
      assert.equal(h.origin_accepted, false);
      const r = await adm.hold("0".repeat(64), "sdktest");
      assert.deepEqual([r.granted, r.reason], [false, "not held"]);
      const bad = new ClusterAdmin({ baseUrl: cluster.urls[0], clusterToken: "wrong" });
      await assert.rejects(bad.inventory(), AuthError);
    } finally {
      await a.storeDelete(put.file_id);
    }
  });
});
