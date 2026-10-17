import { DatranError, NotFoundError, TransportError, errorForStatus } from "./errors.js";
import type {
  ClusterStatus,
  CompressMeta,
  CompressResult,
  CompressStreamResult,
  DeleteResult,
  EntropyResult,
  EvolutionStatus,
  GetResult,
  GetStreamResult,
  HeadResult,
  Health,
  HoldResult,
  Inventory,
  PutResult,
  RangeInfo,
  Recipe,
  StoreStats,
} from "./types.js";

/** Request body. Streams/iterables are sent with chunked transfer encoding; a Blob (e.g. `fs.openAsBlob(path)`) streams with a known length. */
export type BodyInput =
  | Uint8Array
  | ArrayBuffer
  | Blob
  | string
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>
  | Iterable<Uint8Array>;

/** `"bytes=0-99"`, `{ start, end? }` (end inclusive) or `{ suffix: n }` (last n bytes). */
export type RangeSpec = string | { start: number; end?: number } | { suffix: number };

export interface ClientOptions {
  /** e.g. `http://127.0.0.1:3005` */
  baseUrl: string;
  /** `x-reactor-token`; omit when the reactor runs without a token. */
  token?: string;
  /** Deadline for receiving response headers (and the whole body for buffered calls). Default 60 000 ms. */
  timeoutMs?: number;
  /** Retries for idempotent requests (GET/HEAD) on network errors and 429/502/503/504. Default 3. */
  maxRetries?: number;
  /** Base backoff; attempt n waits backoffMs·2^(n-1) plus jitter (capped at 10 s). Default 200 ms. */
  backoffMs?: number;
  /** Custom fetch implementation (default: global fetch). */
  fetch?: typeof fetch;
}

export interface UploadOptions {
  /** `x-content-type` classification hint (MIME). */
  contentType?: string;
  /** Send `x-reactor-no-sample: 1`. */
  noSample?: boolean;
  signal?: AbortSignal;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface GetOptions extends CallOptions {
  range?: RangeSpec;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);

export function formatRange(r: RangeSpec): string {
  if (typeof r === "string") return r.startsWith("bytes=") ? r : `bytes=${r}`;
  if ("suffix" in r) {
    if (!Number.isInteger(r.suffix) || r.suffix <= 0) throw new RangeError("suffix must be a positive integer");
    return `bytes=-${r.suffix}`;
  }
  const { start, end } = r;
  if (!Number.isInteger(start) || start < 0 || (end !== undefined && (!Number.isInteger(end) || end < start))) {
    throw new RangeError(`invalid range ${JSON.stringify(r)}`);
  }
  return `bytes=${start}-${end ?? ""}`;
}

export function parseContentRange(v: string): { start: number; end: number; total: number | undefined } {
  const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/.exec(v);
  if (!m) throw new TransportError(`invalid Content-Range ${JSON.stringify(v)}`);
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? undefined : Number(m[3]) };
}

function toBody(b: BodyInput): { body: BodyInit; stream: boolean } {
  if (typeof b === "string" || b instanceof Uint8Array || b instanceof ArrayBuffer || b instanceof Blob) {
    return { body: b as BodyInit, stream: false };
  }
  if (b instanceof ReadableStream) return { body: b, stream: true };
  const it = b as AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
  const iterator =
    Symbol.asyncIterator in it
      ? (it as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]()
      : (it as Iterable<Uint8Array>)[Symbol.iterator]();
  const stream = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const { value, done } = await iterator.next();
      if (done) ctrl.close();
      else if (value.length > 0) ctrl.enqueue(value);
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
  return { body: stream, stream: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function num(h: Headers, k: string, d = 0): number {
  const v = h.get(k);
  if (v === null) return d;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

function compressMeta(h: Headers, size?: number): CompressMeta {
  let recipe: Recipe | null = null;
  try {
    const r = JSON.parse(h.get("x-reactor-recipe") ?? "null");
    if (r && typeof r === "object") recipe = r as Recipe;
  } catch {
    /* ignore */
  }
  const meta: CompressMeta = {
    contentClass: h.get("x-reactor-class") ?? "",
    recipe,
    format: h.get("x-reactor-format") ?? "",
    originalSize: num(h, "x-original-size"),
    compressedSize: num(h, "x-compressed-size", size ?? 0),
    algo: h.get("x-datran-algo") ?? "",
    ratio: num(h, "x-datran-ratio"),
    timeUs: num(h, "x-datran-time-us"),
    entropy: num(h, "x-datran-entropy"),
    headers: h,
  };
  const note = h.get("x-reactor-note");
  if (note) meta.note = note;
  return meta;
}

function rangeInfo(res: Response): RangeInfo {
  const len = res.headers.get("content-length");
  const length = len === null ? undefined : Number(len);
  const cr = res.headers.get("content-range");
  const etag = res.headers.get("etag");
  if (res.status === 206 && cr) {
    const p = parseContentRange(cr);
    return { status: 206, ...p, length, etag, headers: res.headers };
  }
  return {
    status: res.status,
    start: 0,
    end: length === undefined ? -1 : length - 1,
    total: length,
    length,
    etag,
    headers: res.headers,
  };
}

interface Sent {
  res: Response;
  /** Clears the header timeout (call once the body has been consumed or handed to the caller). */
  done: () => void;
}

/** Client for one Datran core reactor. */
export class DatranClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  readonly backoffMs: number;
  readonly #fetch: typeof fetch;

  constructor(opts: ClientOptions | string, token?: string) {
    const o: ClientOptions = typeof opts === "string" ? { baseUrl: opts, token } : opts;
    const u = new URL(o.baseUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new TypeError(`invalid baseUrl ${o.baseUrl}`);
    this.baseUrl = o.baseUrl.replace(/\/+$/, "");
    this.token = o.token || undefined;
    this.timeoutMs = o.timeoutMs ?? 60_000;
    this.maxRetries = Math.max(0, o.maxRetries ?? 3);
    this.backoffMs = o.backoffMs ?? 200;
    this.#fetch = o.fetch ?? globalThis.fetch.bind(globalThis);
  }

  // ------------------------------------------------------------------ transport

  async #send(
    method: string,
    path: string,
    body?: BodyInput,
    headers: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<Sent> {
    const idempotent = (method === "GET" || method === "HEAD") && body === undefined;
    const attempts = idempotent ? this.maxRetries + 1 : 1;
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) {
        const d = Math.min(10_000, this.backoffMs * 2 ** (attempt - 1));
        await sleep(d + Math.random() * (d / 2));
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(new TransportError(`${method} ${path}: timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
      const onAbort = () => ctrl.abort(signal?.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const h: Record<string, string> = { ...headers };
      if (this.token) h["x-reactor-token"] = this.token;
      const init: RequestInit & { duplex?: "half" } = { method, headers: h, signal: ctrl.signal };
      if (body !== undefined) {
        const b = toBody(body);
        init.body = b.body;
        if (b.stream) init.duplex = "half";
        h["content-type"] ??= "application/octet-stream";
      }
      let res: Response;
      try {
        res = await this.#fetch(this.baseUrl + path, init);
      } catch (e) {
        done();
        if (signal?.aborted) throw new TransportError(`${method} ${path}: aborted`, { cause: e });
        const reason = ctrl.signal.aborted ? ctrl.signal.reason : e;
        last = reason instanceof DatranError ? reason : new TransportError(`${method} ${path}: ${(e as Error)?.message ?? e}`, { cause: e });
        continue;
      }
      if (res.ok) return { res, done };
      let data: Uint8Array;
      try {
        data = method === "HEAD" ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
      } catch {
        data = new Uint8Array();
      } finally {
        done();
      }
      const err = errorForStatus(res.status, data, res.headers, res.statusText);
      if (idempotent && RETRY_STATUSES.has(res.status) && attempt + 1 < attempts) {
        last = err;
        continue;
      }
      throw err;
    }
    throw last;
  }

  async #bytes(s: Sent, method: string, path: string): Promise<Uint8Array> {
    try {
      return new Uint8Array(await s.res.arrayBuffer());
    } catch (e) {
      throw new TransportError(`${method} ${path}: error reading body: ${(e as Error)?.message ?? e}`, { cause: e });
    } finally {
      s.done();
    }
  }

  async #json<T>(method: string, path: string, body?: BodyInput, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    const s = await this.#send(method, path, body, headers, signal);
    const data = await this.#bytes(s, method, path);
    if (data.length === 0) return {} as T;
    try {
      return JSON.parse(new TextDecoder().decode(data)) as T;
    } catch (e) {
      throw new TransportError(`${method} ${path}: invalid JSON response`, { cause: e });
    }
  }

  /** Wraps a response body so the header timer is cleared once streaming starts. */
  #stream(s: Sent): ReadableStream<Uint8Array> {
    s.done();
    return s.res.body ?? new ReadableStream({ start: (c) => c.close() });
  }

  // ------------------------------------------------------------------ system / data plane

  /** `GET /health` (no auth). */
  health(opts: CallOptions = {}): Promise<Health> {
    return this.#json("GET", "/health", undefined, undefined, opts.signal);
  }

  /** `POST /compress`. */
  async compress(data: BodyInput, opts: UploadOptions = {}): Promise<CompressResult> {
    const s = await this.#send("POST", "/compress", data, hints(opts), opts.signal);
    const bytes = await this.#bytes(s, "POST", "/compress");
    return { ...compressMeta(s.res.headers, bytes.length), data: bytes };
  }

  /** `POST /compress` returning the blob as a stream (metadata is available immediately). */
  async compressStream(data: BodyInput, opts: UploadOptions = {}): Promise<CompressStreamResult> {
    const s = await this.#send("POST", "/compress", data, hints(opts), opts.signal);
    return { ...compressMeta(s.res.headers), body: this.#stream(s) };
  }

  /** `POST /decompress`. Throws BadRequestError for corrupt blobs or unknown dictionaries. */
  async decompress(blob: BodyInput, opts: CallOptions = {}): Promise<Uint8Array> {
    const s = await this.#send("POST", "/decompress", blob, {}, opts.signal);
    return this.#bytes(s, "POST", "/decompress");
  }

  /** `POST /decompress` returning the original bytes as a stream. */
  async decompressStream(blob: BodyInput, opts: CallOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const s = await this.#send("POST", "/decompress", blob, {}, opts.signal);
    return this.#stream(s);
  }

  /** `POST /entropy`. */
  entropy(data: BodyInput, opts: CallOptions = {}): Promise<EntropyResult> {
    return this.#json("POST", "/entropy", data, {}, opts.signal);
  }

  /** `GET /evolution/status`. */
  evolutionStatus(opts: CallOptions = {}): Promise<EvolutionStatus> {
    return this.#json("GET", "/evolution/status", undefined, undefined, opts.signal);
  }

  // ------------------------------------------------------------------ store

  /** `PUT /store/files`. Never retried (each successful PUT adds a pin). 507 -> InsufficientStorageError (`storeFull`). */
  storePut(data: BodyInput, opts: UploadOptions = {}): Promise<PutResult> {
    return this.#json("PUT", "/store/files", data, hints(opts), opts.signal);
  }

  /** `GET /store/files/:id` into memory (206 with `range`). */
  async storeGet(fileId: string, opts: GetOptions = {}): Promise<GetResult> {
    const path = filePath(fileId);
    const s = await this.#send("GET", path, undefined, rangeHeader(opts.range), opts.signal);
    const info = rangeInfo(s.res);
    const data = await this.#bytes(s, "GET", path);
    if (info.length !== undefined && info.length !== data.length) {
      throw new TransportError(`GET ${path}: truncated body (${data.length} of ${info.length} bytes)`);
    }
    if (info.status !== 206) {
      info.end = data.length - 1;
      info.total = data.length;
    }
    return { ...info, length: data.length, data };
  }

  /** `GET /store/files/:id` as a stream (pipe it to a file with `Readable.fromWeb` / `stream.pipeline`). */
  async storeGetStream(fileId: string, opts: GetOptions = {}): Promise<GetStreamResult> {
    const s = await this.#send("GET", filePath(fileId), undefined, rangeHeader(opts.range), opts.signal);
    return { ...rangeInfo(s.res), body: this.#stream(s) };
  }

  /** `HEAD /store/files/:id`. Throws NotFoundError for unknown files. */
  async storeHead(fileId: string, opts: CallOptions = {}): Promise<HeadResult> {
    const s = await this.#send("HEAD", filePath(fileId), undefined, {}, opts.signal);
    s.done();
    await s.res.body?.cancel();
    return {
      size: Number(s.res.headers.get("content-length") ?? 0),
      acceptRanges: s.res.headers.get("accept-ranges"),
      etag: s.res.headers.get("etag"),
      headers: s.res.headers,
    };
  }

  async storeExists(fileId: string, opts: CallOptions = {}): Promise<boolean> {
    try {
      await this.storeHead(fileId, opts);
      return true;
    } catch (e) {
      if (e instanceof NotFoundError) return false;
      throw e;
    }
  }

  /** `DELETE /store/files/:id` (unpin once; never retried). Throws NotFoundError once no longer stored. */
  storeDelete(fileId: string, opts: CallOptions = {}): Promise<DeleteResult> {
    return this.#json("DELETE", filePath(fileId), undefined, undefined, opts.signal);
  }

  /** `GET /store/stats`. Throws ServerError (503) when the object store is disabled. */
  storeStats(opts: CallOptions = {}): Promise<StoreStats> {
    return this.#json("GET", "/store/stats", undefined, undefined, opts.signal);
  }

  /**
   * `GET /cluster/status`: node config, per-peer health, sampled holders, top demand and data-gravity
   * metrics. Throws ServerError (503) when data gravity is disabled (no store or no `REACTOR_CLUSTER_TOKEN`).
   */
  clusterStatus(opts: CallOptions = {}): Promise<ClusterStatus> {
    return this.#json("GET", "/cluster/status", undefined, undefined, opts.signal);
  }

  /**
   * Low-level escape hatch: a JSON request without a body to any path (GET/HEAD are retried like the
   * typed calls). Use for endpoints the client does not wrap.
   */
  requestJson<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    return this.#json(method, path, undefined, opts.headers, opts.signal);
  }
}

export interface RequestOptions extends CallOptions {
  headers?: Record<string, string>;
}

/**
 * Low-level access to the internal peer endpoints (`x-cluster-token`), for operators and debugging
 * tools, not applications. Only `/cluster/inventory` and `/cluster/hold/:id` are wrapped (manifests,
 * objects, chunks and unpin are peer-to-peer transfer endpoints, see openapi.yaml). A granted hold is
 * a real lease: the holder will not drop the replica for `lease_ms`.
 */
export class ClusterAdmin {
  readonly #c: DatranClient;
  readonly #h: Record<string, string>;

  constructor(opts: Omit<ClientOptions, "token"> & { clusterToken: string }) {
    const { clusterToken, ...rest } = opts;
    this.#c = new DatranClient({ timeoutMs: 30_000, ...rest });
    this.#h = { "x-cluster-token": clusterToken };
  }

  /** `GET /cluster/inventory`: full listing without `since`, else the delta after `since`. */
  inventory(q: { since?: number; tsince?: number } = {}, opts: CallOptions = {}): Promise<Inventory> {
    const p = new URLSearchParams();
    if (q.since !== undefined) p.set("since", String(q.since));
    if (q.tsince !== undefined) p.set("tsince", String(q.tsince));
    const qs = p.toString();
    return this.#c.requestJson("GET", `/cluster/inventory${qs ? `?${qs}` : ""}`, { headers: this.#h, signal: opts.signal });
  }

  /**
   * `POST /cluster/hold/:id?node=..`: asks the node to lease (not drop) its replica; with `origin`
   * also to take over origin and `pins` pins. Never retried.
   */
  hold(fileId: string, node: string, o: { origin?: boolean; pins?: number } & CallOptions = {}): Promise<HoldResult> {
    const p = new URLSearchParams({ node });
    if (o.origin) {
      p.set("origin", "1");
      p.set("pins", String(o.pins ?? 0));
    }
    return this.#c.requestJson("POST", `/cluster/hold/${encodeURIComponent(fileId)}?${p}`, { headers: this.#h, signal: o.signal });
  }
}

function hints(o: UploadOptions): Record<string, string> {
  const h: Record<string, string> = {};
  if (o.contentType) h["x-content-type"] = o.contentType;
  if (o.noSample) h["x-reactor-no-sample"] = "1";
  return h;
}

function rangeHeader(r: RangeSpec | undefined): Record<string, string> {
  return r === undefined ? {} : { range: formatRange(r) };
}

function filePath(id: string): string {
  return `/store/files/${encodeURIComponent(id)}`;
}
