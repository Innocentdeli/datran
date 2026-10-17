import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthError,
  BadRequestError,
  ClusterAdmin,
  DatranClient,
  InsufficientStorageError,
  RangeNotSatisfiableError,
  ServerError,
  TransportError,
  errorForStatus,
  formatRange,
  parseContentRange,
} from "../dist/index.js";

const enc = (s) => new TextEncoder().encode(s);

test("formatRange / parseContentRange", () => {
  assert.equal(formatRange({ start: 0, end: 99 }), "bytes=0-99");
  assert.equal(formatRange({ start: 10 }), "bytes=10-");
  assert.equal(formatRange({ suffix: 5 }), "bytes=-5");
  assert.equal(formatRange("3-4"), "bytes=3-4");
  assert.throws(() => formatRange({ start: 5, end: 1 }), RangeError);
  assert.throws(() => formatRange({ suffix: 0 }), RangeError);
  assert.deepEqual(parseContentRange("bytes 0-99/1000"), { start: 0, end: 99, total: 1000 });
  assert.deepEqual(parseContentRange("bytes 5-6/*"), { start: 5, end: 6, total: undefined });
  assert.throws(() => parseContentRange("nope"), TransportError);
});

test("error mapping", () => {
  const h = new Headers();
  const e = errorForStatus(401, enc('{"error":"missing or invalid x-reactor-token"}'), h);
  assert.ok(e instanceof AuthError);
  assert.equal(e.serverMessage, "missing or invalid x-reactor-token");
  const d = errorForStatus(400, enc(`{"error":"x","unknown_dict":"${"0".repeat(64)}"}`), h);
  assert.ok(d instanceof BadRequestError);
  assert.equal(d.unknownDict, "0".repeat(64));
  const r = errorForStatus(416, new Uint8Array(), new Headers({ "content-range": "bytes */1234" }));
  assert.ok(r instanceof RangeNotSatisfiableError);
  assert.equal(r.size, 1234);
  assert.ok(errorForStatus(507, new Uint8Array(), h) instanceof InsufficientStorageError);
  assert.equal(errorForStatus(507, new Uint8Array(), h).storeFull, undefined);
  const full = errorForStatus(507, enc('{"error":"store full","needed":10,"used":90,"max":95}'), h);
  assert.equal(full.serverMessage, "store full");
  assert.deepEqual(full.storeFull, { error: "store full", needed: 10, used: 90, max: 95 });
  assert.ok(errorForStatus(502, new Uint8Array(), h) instanceof ServerError);
});

function stubFetch(statuses) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(`${init.method} ${new URL(url).pathname}`);
    const status = statuses.length > 1 ? statuses.shift() : statuses[0];
    return new Response(status === 200 ? '{"status":"online"}' : '{"error":"busy"}', { status });
  };
  return { f, calls };
}

test("GET retried on 503, POST never retried", async () => {
  let { f, calls } = stubFetch([503, 503, 200]);
  let c = new DatranClient({ baseUrl: "http://stub", fetch: f, backoffMs: 1 });
  assert.equal((await c.health()).status, "online");
  assert.equal(calls.length, 3);

  ({ f, calls } = stubFetch([503]));
  c = new DatranClient({ baseUrl: "http://stub", fetch: f, backoffMs: 1, maxRetries: 2 });
  await assert.rejects(c.health(), (e) => e instanceof ServerError && e.status === 503);
  assert.equal(calls.length, 3);

  ({ f, calls } = stubFetch([503]));
  c = new DatranClient({ baseUrl: "http://stub", fetch: f, backoffMs: 1 });
  await assert.rejects(c.decompress(enc("x")), ServerError);
  await assert.rejects(c.storeDelete("ab"), ServerError);
  assert.deepEqual(calls, ["POST /decompress", "DELETE /store/files/ab"]);
});

test("ClusterAdmin sends x-cluster-token (no reactor token), hold never retried", async () => {
  const seen = [];
  const f = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers });
    return new Response('{"error":"busy"}', { status: 503 });
  };
  const adm = new ClusterAdmin({ baseUrl: "http://stub", clusterToken: "ctok", fetch: f, backoffMs: 1, maxRetries: 0 });
  await assert.rejects(adm.hold("ab", "n1", { origin: true, pins: 2 }), ServerError);
  await assert.rejects(adm.inventory({ since: 3, tsince: 9 }), ServerError);
  assert.deepEqual(
    seen.map((s) => `${s.method} ${s.url}`),
    ["POST http://stub/cluster/hold/ab?node=n1&origin=1&pins=2", "GET http://stub/cluster/inventory?since=3&tsince=9"],
  );
  assert.equal(seen[0].headers["x-cluster-token"], "ctok");
  assert.equal(seen[0].headers["x-reactor-token"], undefined);
});

test("connection refused -> TransportError", async () => {
  const c = new DatranClient({ baseUrl: "http://127.0.0.1:9", maxRetries: 1, backoffMs: 1, timeoutMs: 3000 });
  await assert.rejects(c.health(), TransportError);
});

test("timeout -> TransportError", async () => {
  const hang = (_url, init) =>
    new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
  const c = new DatranClient({ baseUrl: "http://stub", fetch: hang, timeoutMs: 50, maxRetries: 0 });
  await assert.rejects(c.health(), (e) => e instanceof TransportError && /timed out/.test(e.message));
});
