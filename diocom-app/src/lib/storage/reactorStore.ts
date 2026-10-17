import http from 'http';
import https from 'https';
import { getReactorUrl } from '../reactorWorker';
import { parseStorePutResult, StorePutResult, isValidStoreFileId, storeFullMessage } from './reactorStoreCore';

/**
 * HTTP client for the reactor chunked object store (core-reactor/docs/NETWORK_SPEC.md §2, auth `x-reactor-token`).
 * Relative imports only: also used by scripts/migrate_to_reactor_store.ts outside Next.js.
 *
 * Env: REACTOR_URL / REACTOR_PORT, REACTOR_TOKEN, REACTOR_STORE_TIMEOUT_MS (uploads/full reads, default 10 min),
 * REACTOR_TIMEOUT_MS (time to response headers for reads/deletes, default 30 s).
 */

export class ReactorStoreFullError extends Error {
    readonly body: unknown;
    constructor(body: unknown) {
        super(storeFullMessage(body));
        this.name = 'ReactorStoreFullError';
        this.body = body;
    }
}

/** Reactor unreachable, store disabled (503) or an unexpected status. */
export class ReactorStoreUnavailableError extends Error {
    readonly status: number | null;
    constructor(message: string, status: number | null = null) {
        super(message);
        this.name = 'ReactorStoreUnavailableError';
        this.status = status;
    }
}

function envMs(name: string, fallback: number): number {
    const v = parseInt(process.env[name] || '', 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

export const storeTimeoutMs = () => envMs('REACTOR_STORE_TIMEOUT_MS', 600_000);
export const storeHeadersTimeoutMs = () => envMs('REACTOR_TIMEOUT_MS', 30_000);

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { ...extra };
    if (process.env.REACTOR_TOKEN) h['x-reactor-token'] = process.env.REACTOR_TOKEN;
    return h;
}

function fileUrl(fileId: string): string {
    if (!isValidStoreFileId(fileId)) throw new Error('Invalid reactor store file id');
    return `${getReactorUrl()}/store/files/${fileId}`;
}

export interface PutOptions {
    contentType?: string;
    /** `x-reactor-no-sample: 1` — never feed this upload to evolution (protected / client-encrypted content). */
    noSample?: boolean;
    /** Known body length (sent as Content-Length for streamed bodies). */
    contentLength?: number;
}

function putHeaders(opts: PutOptions): Record<string, string> {
    const headers = authHeaders({ 'Content-Type': 'application/octet-stream' });
    const mime = opts.contentType?.trim();
    if (mime && mime.length <= 255 && /^[\x21-\x7e]+(\s*;[\x20-\x7e]*)?$/.test(mime)) headers['x-content-type'] = mime;
    if (opts.noSample) headers['x-reactor-no-sample'] = '1';
    return headers;
}

/** Maps a PUT /store/files response (status + body text) to a result or the typed errors. */
function putResult(status: number, text: string): StorePutResult {
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (status === 507) throw new ReactorStoreFullError(json);
    if (status < 200 || status >= 300) {
        const msg = json && typeof json === 'object' && typeof (json as { error?: unknown }).error === 'string'
            ? (json as { error: string }).error : `HTTP ${status}`;
        throw new ReactorStoreUnavailableError(`reactor store PUT failed: ${msg}`, status);
    }
    return parseStorePutResult(json);
}

/**
 * PUT /store/files. `body` may be a buffer or a stream (streamed with duplex: 'half'; the reactor chunks it as it
 * arrives). Throws ReactorStoreFullError on 507, ReactorStoreUnavailableError when the store can't be reached.
 */
export async function putStoreFile(body: Uint8Array | ReadableStream<Uint8Array>, opts: PutOptions = {}): Promise<StorePutResult> {
    const headers = putHeaders(opts);
    if (opts.contentLength !== undefined && !(body instanceof Uint8Array)) headers['Content-Length'] = String(opts.contentLength);

    let res: Response;
    try {
        res = await fetch(`${getReactorUrl()}/store/files`, {
            method: 'PUT',
            headers,
            body: body as BodyInit,
            // Required by undici for stream bodies; harmless for buffers.
            duplex: 'half',
            signal: AbortSignal.timeout(storeTimeoutMs()),
        } as RequestInit & { duplex: 'half' });
    } catch (e) {
        throw new ReactorStoreUnavailableError(`reactor store unreachable: ${e instanceof Error ? e.message : e}`);
    }
    const text = await res.text().catch(() => '');
    return putResult(res.status, text);
}

/**
 * Streaming PUT /store/files: returns a sink that writes the body as it arrives (chunked transfer encoding, no
 * Content-Length; the reactor's axum handler consumes the body as a stream). Uses node:http directly so socket
 * backpressure reaches the caller (`write` resolves once the socket drained) and memory stays bounded; the WHATWG
 * fetch + Readable.toWeb path was measured to queue the whole body in memory when the reactor is slower than the
 * client. `abort()` destroys the request, so the reactor never commits a partial file.
 */
export function openStorePutStream(opts: Omit<PutOptions, 'contentLength'> = {}): {
    write(chunk: Buffer): Promise<void>;
    end(): Promise<StorePutResult>;
    abort(reason: Error): void;
} {
    const url = new URL(`${getReactorUrl()}/store/files`);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: 'PUT', headers: putHeaders(opts) });
    const timer = setTimeout(() => req.destroy(new ReactorStoreUnavailableError('reactor store PUT timed out')), storeTimeoutMs());
    let settled = false;
    let aborted: Error | null = null;
    const put = new Promise<StorePutResult>((resolve, reject) => {
        req.on('response', (res) => {
            const parts: Buffer[] = [];
            let len = 0;
            res.on('data', (c: Buffer) => { if (len < 1024 * 1024) { parts.push(c); len += c.length; } });
            res.on('end', () => {
                try { resolve(putResult(res.statusCode ?? 0, Buffer.concat(parts).toString('utf8'))); } catch (e) { reject(e); }
            });
            res.on('error', (e) => reject(new ReactorStoreUnavailableError(`reactor store PUT failed: ${e.message}`)));
        });
        req.on('error', (e) => {
            if (aborted) reject(aborted);
            else if (e instanceof ReactorStoreUnavailableError) reject(e);
            else reject(new ReactorStoreUnavailableError(`reactor store unreachable: ${e.message}`));
        });
    });
    // If the reactor answers before the body is complete (e.g. 507 mid-upload), surface that instead of hanging.
    const early = () => put.then(
        () => { throw new ReactorStoreUnavailableError('reactor store finished the upload before the body was complete'); },
    );
    let waiter: { resolve: () => void; reject: (e: unknown) => void } | null = null;
    req.on('drain', () => { const w = waiter; waiter = null; w?.resolve(); });
    const onSettled = () => {
        settled = true;
        clearTimeout(timer);
        const w = waiter;
        waiter = null;
        if (w) early().catch(w.reject);
    };
    put.then(onSettled, onSettled);
    return {
        async write(chunk) {
            if (settled) return early();
            if (req.write(chunk)) return;
            await new Promise<void>((resolve, reject) => { waiter = { resolve, reject }; });
        },
        async end() {
            req.end();
            return put;
        },
        abort(reason) {
            if (settled || aborted) return;
            aborted = reason;
            req.destroy(reason);
        },
    };
}

export interface GetOptions {
    range?: string | null;
    /** Aborts the upstream request (e.g. the client disconnected). */
    signal?: AbortSignal;
    /** Time allowed until response headers arrive; the body itself may stream for as long as needed. */
    headersTimeoutMs?: number;
}

/**
 * GET /store/files/:id with an optional Range. Returns the raw upstream Response (body not consumed) so callers can
 * stream it. Throws ReactorStoreUnavailableError when the reactor can't be reached in time.
 */
export async function getStoreFile(fileId: string, opts: GetOptions = {}): Promise<Response> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    if (opts.signal) {
        if (opts.signal.aborted) ctrl.abort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), opts.headersTimeoutMs ?? storeHeadersTimeoutMs());
    try {
        const headers = authHeaders();
        if (opts.range) headers['Range'] = opts.range;
        return await fetch(fileUrl(fileId), { method: 'GET', headers, signal: ctrl.signal, cache: 'no-store' });
    } catch (e) {
        throw new ReactorStoreUnavailableError(`reactor store unreachable: ${e instanceof Error ? e.message : e}`);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Reads a whole stored file into memory (bounded by maxBytes). Returns null when the store doesn't hold it.
 * The reactor verifies every chunk hash before returning bytes; the length is checked here.
 */
export async function readStoreFile(fileId: string, maxBytes: number): Promise<Buffer | null> {
    const res = await getStoreFile(fileId, { headersTimeoutMs: storeTimeoutMs() });
    if (res.status === 404) { await res.body?.cancel().catch(() => { }); return null; }
    if (res.status !== 200) {
        await res.body?.cancel().catch(() => { });
        throw new ReactorStoreUnavailableError(`reactor store GET returned ${res.status}`, res.status);
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => { });
        throw new Error(`stored file is larger than ${maxBytes} bytes`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (Number.isFinite(declared) && buf.length !== declared) throw new Error('short read from reactor store');
    return buf;
}

/**
 * Touches a file (small ranged GET, body drained) so the reactor records demand for data gravity without the app
 * buffering the whole file. Returns false when the store doesn't hold it.
 */
export async function touchStoreFile(fileId: string, bytes = 65_536): Promise<boolean> {
    const res = await getStoreFile(fileId, { range: `bytes=0-${Math.max(0, bytes - 1)}` });
    if (res.status === 404) { await res.body?.cancel().catch(() => { }); return false; }
    if (res.status !== 200 && res.status !== 206) {
        await res.body?.cancel().catch(() => { });
        throw new ReactorStoreUnavailableError(`reactor store GET returned ${res.status}`, res.status);
    }
    await res.arrayBuffer();
    return true;
}

/** DELETE /store/files/:id (= unpin). 404 (already gone) is tolerated. */
export async function deleteStoreFile(fileId: string): Promise<{ deleted: boolean; notFound: boolean; pins: number | null }> {
    let res: Response;
    try {
        res = await fetch(fileUrl(fileId), {
            method: 'DELETE',
            headers: authHeaders(),
            signal: AbortSignal.timeout(storeHeadersTimeoutMs()),
        });
    } catch (e) {
        throw new ReactorStoreUnavailableError(`reactor store unreachable: ${e instanceof Error ? e.message : e}`);
    }
    const json = await res.json().catch(() => null) as { deleted?: unknown; pins?: unknown } | null;
    if (res.status === 404) return { deleted: false, notFound: true, pins: null };
    if (!res.ok) throw new ReactorStoreUnavailableError(`reactor store DELETE returned ${res.status}`, res.status);
    return { deleted: json?.deleted === true, notFound: false, pins: typeof json?.pins === 'number' ? json.pins : null };
}

/** GET a small JSON status document from the reactor (admin). Returns { status, body } without throwing on HTTP errors. */
export async function getReactorJson(path: string, maxBytes = 2 * 1024 * 1024, timeoutMs = 5_000): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${getReactorUrl()}${path}`, {
        headers: authHeaders({ Accept: 'application/json' }),
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (text.length > maxBytes) throw new Error('response too large');
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { status: res.status, body };
}
