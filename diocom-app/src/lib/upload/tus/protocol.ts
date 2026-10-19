import { createHash, randomBytes, type Hash } from 'crypto';
import { StagingStore, TUS_ID_RE, type TusUploadInfo, type TusStoredResponse } from './stagingStore';
import { LockLostError, type HeldLock, type TusLocker } from './locker';

/**
 * tus 1.0.0 resumable upload server (https://tus.io/protocols/resumable-upload) on WHATWG Request/Response, so it
 * plugs straight into Next.js App Router route handlers. No Next.js / '@/' imports: unit-tested from the repo root.
 *
 * Extensions: creation, creation-with-upload, termination, expiration, checksum (sha1, sha256, md5).
 * Not supported: creation-defer-length, concatenation.
 *
 * Completion: when the last byte arrives (final PATCH, or a POST carrying the whole file) `hooks.onComplete` runs
 * under the upload lock. The response then carries `Diocom-Upload-State` (done | complete | failed) and, when done,
 * the hook's headers (the app adds `Diocom-Share-Link`). `GET <upload url>` (not part of tus) returns the finalize
 * result as JSON at any time: 200 with the result, 202 while uploading/finalizing, or the stored error. A GET on a
 * 'complete' upload (finalize failed with a retryable error, or the finalizing instance crashed) retries finalize.
 */

export const TUS_VERSION = '1.0.0';
export const TUS_EXTENSIONS = 'creation,creation-with-upload,termination,expiration,checksum';
export const TUS_CHECKSUM_ALGORITHMS = ['sha1', 'sha256', 'md5'] as const;
export const OFFSET_CONTENT_TYPE = 'application/offset+octet-stream';
export const STATE_HEADER = 'Diocom-Upload-State';

/** Request-level failure; `retryable` (finalize only): keep the received data so finalize can be retried. */
export class TusError extends Error {
    constructor(
        readonly status: number,
        message: string,
        readonly body?: unknown,
        readonly headers: Record<string, string> = {},
        readonly retryable = false,
    ) {
        super(message);
        this.name = 'TusError';
    }
}

export interface CreateInput {
    length: number;
    /** Decoded Upload-Metadata (a key without value maps to null). */
    metadata: Record<string, string | null>;
}

export interface CreateDecision {
    ownerId: string | null;
    /** Application data kept with the upload (JSON). */
    context: Record<string, unknown>;
    /** Metadata to keep and echo in HEAD (default: the input without null values). Never include secrets. */
    metadata?: Record<string, string>;
}

export interface CompleteResult {
    /** Extra headers for the completing response and later HEADs (e.g. the share link). */
    headers?: Record<string, string>;
    /** JSON returned by GET <upload url>. */
    body: unknown;
}

export interface TusHooks {
    /** Validates a creation request (auth, rate limit, metadata, size). Throw TusError to reject. */
    onCreate(req: Request, input: CreateInput): Promise<CreateDecision>;
    /** Access check for every request on an existing upload. Throw TusError to deny. */
    authorize?(req: Request, info: TusUploadInfo): Promise<void>;
    /**
     * All bytes are in `dataPath`. Store them; throw TusError (retryable or not) on failure. The hook may move the
     * file away (it is deleted afterwards if still present).
     */
    onComplete(req: Request, info: TusUploadInfo, dataPath: string): Promise<CompleteResult>;
}

export interface TusServerOptions {
    /** Route of the creation endpoint, e.g. '/api/uploads'. Upload URLs are `${basePath}/${id}`. */
    basePath: string;
    store: StagingStore;
    locker: TusLocker;
    hooks: TusHooks;
    /** Largest accepted Upload-Length (read per request). */
    maxSize: () => number;
    /** Idle time after which an unfinished upload expires (Upload-Expires = last write + expiryMs). */
    expiryMs: number;
    /** How long the finalize result stays readable (GET/HEAD) after completion. Default 1 hour. */
    resultRetentionMs?: number;
    /** How long a request waits for the upload lock. Default 10 s. */
    lockWaitMs?: number;
    /** Persist the offset every this many bytes during a PATCH without checksum. Default 8 MiB. */
    persistEveryBytes?: number;
    now?: () => number;
    log?: (msg: string) => void;
}

// ---------------------------------------------------------------------------------------------------------------
// Header codecs
// ---------------------------------------------------------------------------------------------------------------

/** Parses Upload-Metadata: comma-separated `key base64value` pairs (value optional). Throws TusError 400. */
export function parseMetadata(header: string | null): Record<string, string | null> {
    const out: Record<string, string | null> = Object.create(null);
    if (!header || !header.trim()) return out;
    for (const pair of header.split(',')) {
        const parts = pair.trim().split(' ');
        const key = parts[0];
        if (!key || parts.length > 2 || !/^[\x21-\x2b\x2d-\x7e]+$/.test(key)) {
            throw new TusError(400, 'Invalid Upload-Metadata');
        }
        if (Object.prototype.hasOwnProperty.call(out, key)) throw new TusError(400, `Duplicate Upload-Metadata key ${key}`);
        if (parts.length === 1 || parts[1] === '') {
            out[key] = null;
            continue;
        }
        const b64 = parts[1];
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new TusError(400, `Invalid base64 in Upload-Metadata (${key})`);
        out[key] = Buffer.from(b64, 'base64').toString('utf8');
    }
    return out;
}

export function encodeMetadata(meta: Record<string, string>): string {
    return Object.entries(meta).map(([k, v]) => `${k} ${Buffer.from(v, 'utf8').toString('base64')}`).join(',');
}

function parseNonNegInt(v: string | null): number | null {
    if (v === null || !/^\d{1,16}$/.test(v.trim())) return null;
    const n = Number(v.trim());
    return Number.isSafeInteger(n) ? n : null;
}

export function parseChecksum(header: string | null): { algorithm: string; digest: Buffer } | null {
    if (header === null) return null;
    const m = /^\s*([A-Za-z0-9-]+)\s+([A-Za-z0-9+/=]+)\s*$/.exec(header);
    if (!m) throw new TusError(400, 'Invalid Upload-Checksum');
    const algorithm = m[1].toLowerCase();
    if (!(TUS_CHECKSUM_ALGORITHMS as readonly string[]).includes(algorithm)) {
        throw new TusError(400, `Unsupported checksum algorithm ${algorithm}`);
    }
    return { algorithm, digest: Buffer.from(m[2], 'base64') };
}

const httpDate = (ms: number) => new Date(ms).toUTCString();

// ---------------------------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------------------------

export class TusServer {
    private readonly retentionMs: number;
    private readonly lockWaitMs: number;
    private readonly persistEvery: number;
    private readonly now: () => number;
    private readonly log: (msg: string) => void;

    constructor(private readonly o: TusServerOptions) {
        this.retentionMs = o.resultRetentionMs ?? 60 * 60_000;
        this.lockWaitMs = o.lockWaitMs ?? 10_000;
        this.persistEvery = o.persistEveryBytes ?? 8 * 1024 * 1024;
        this.now = o.now ?? Date.now;
        this.log = o.log ?? ((m) => console.log(`[TUS] ${m}`));
    }

    private response(status: number, headers: Record<string, string> = {}, body?: unknown): Response {
        const h = new Headers({ 'Tus-Resumable': TUS_VERSION, 'Cache-Control': 'no-store' });
        for (const [k, v] of Object.entries(headers)) h.set(k, v);
        if (body === undefined || status === 204 || status === 304) return new Response(null, { status, headers: h });
        h.set('Content-Type', 'application/json');
        return new Response(JSON.stringify(body), { status, headers: h });
    }

    private errorResponse(e: TusError, method: string): Response {
        const body = method === 'HEAD' ? undefined : (e.body ?? { success: false, message: e.message });
        return this.response(e.status, e.headers, body);
    }

    /** Upload id for `${basePath}/<id>`, '' for the creation endpoint, null for anything else. */
    private parsePath(pathname: string): string | null {
        const base = this.o.basePath.replace(/\/+$/, '');
        if (pathname === base || pathname === `${base}/`) return '';
        if (!pathname.startsWith(`${base}/`)) return null;
        const rest = pathname.slice(base.length + 1).replace(/\/+$/, '');
        return TUS_ID_RE.test(rest) ? rest : null;
    }

    async handle(req: Request): Promise<Response> {
        let method = req.method.toUpperCase();
        const override = req.headers.get('x-http-method-override');
        if (method === 'POST' && override) method = override.toUpperCase();
        try {
            if (method === 'OPTIONS') {
                return this.response(204, {
                    'Tus-Version': TUS_VERSION,
                    'Tus-Extension': TUS_EXTENSIONS,
                    'Tus-Max-Size': String(this.o.maxSize()),
                    'Tus-Checksum-Algorithm': TUS_CHECKSUM_ALGORITHMS.join(','),
                });
            }
            const id = this.parsePath(new URL(req.url).pathname);
            if (id === null) throw new TusError(404, 'Upload not found');
            if (method === 'GET') {
                if (!id) throw new TusError(405, 'Method not allowed');
                return await this.getResult(req, id);
            }
            if (req.headers.get('tus-resumable') !== TUS_VERSION) {
                throw new TusError(412, 'Unsupported tus version', undefined, { 'Tus-Version': TUS_VERSION });
            }
            if (!id) {
                if (method !== 'POST') throw new TusError(405, 'Method not allowed');
                return await this.create(req);
            }
            switch (method) {
                case 'HEAD': return await this.head(req, id);
                case 'PATCH': return await this.patch(req, id);
                case 'DELETE': return await this.terminate(req, id);
                default: throw new TusError(405, 'Method not allowed');
            }
        } catch (e) {
            if (e instanceof TusError) return this.errorResponse(e, method);
            this.log(`internal error: ${e instanceof Error ? e.stack || e.message : e}`);
            return this.errorResponse(new TusError(500, 'Internal server error', { success: false, message: 'Internal server error', code: 'INTERNAL_ERROR' }), method);
        }
    }

    private isExpired(info: TusUploadInfo): boolean {
        return info.expiresAt <= this.now();
    }

    /** Loads an upload for a request: 404 unknown, 410 expired, hook authorization. */
    private async load(req: Request, id: string): Promise<TusUploadInfo> {
        const info = await this.o.store.loadInfo(id);
        if (!info) throw new TusError(404, 'Upload not found');
        if (this.isExpired(info)) {
            throw new TusError(info.state === 'done' || info.state === 'failed' ? 404 : 410, 'Upload expired');
        }
        await this.o.hooks.authorize?.(req, info);
        return info;
    }

    private stateHeaders(info: TusUploadInfo): Record<string, string> {
        const h: Record<string, string> = { [STATE_HEADER]: info.state };
        if (info.state === 'done' && info.result?.headers) Object.assign(h, info.result.headers);
        return h;
    }

    private async lock(id: string, requestRelease: boolean, waitMs = this.lockWaitMs): Promise<HeldLock> {
        const lock = await this.o.locker.acquire(id, { waitMs, requestRelease });
        if (!lock) throw new TusError(423, 'Upload is locked by another request', undefined, { 'Retry-After': '1' });
        return lock;
    }

    // -- POST (creation, creation-with-upload) ----------------------------------------------------------------------

    private async create(req: Request): Promise<Response> {
        if (req.headers.has('upload-defer-length')) throw new TusError(400, 'Upload-Defer-Length is not supported');
        if (req.headers.has('upload-concat')) throw new TusError(400, 'Upload-Concat is not supported');
        const length = parseNonNegInt(req.headers.get('upload-length'));
        if (length === null) throw new TusError(400, 'Upload-Length header required');
        const max = this.o.maxSize();
        if (length > max) {
            throw new TusError(413, `Upload-Length exceeds the maximum upload size (${max} bytes)`, {
                success: false,
                message: `File exceeds maximum allowed size (${Math.floor(max / (1024 * 1024))}MB)`,
                code: 'FILE_TOO_LARGE',
            });
        }
        const metadata = parseMetadata(req.headers.get('upload-metadata'));
        const ct = req.headers.get('content-type');
        const withBody = !!ct && ct.split(';')[0].trim().toLowerCase() === OFFSET_CONTENT_TYPE;
        if (withBody) this.checkDeclaredLength(req, length);

        const decision = await this.o.hooks.onCreate(req, { length, metadata });
        const kept: Record<string, string> = decision.metadata ?? Object.fromEntries(
            Object.entries(metadata).filter((e): e is [string, string] => e[1] !== null));
        const now = this.now();
        const info: TusUploadInfo = {
            id: randomBytes(24).toString('base64url'),
            length,
            offset: 0,
            metadata: kept,
            createdAt: now,
            expiresAt: now + this.o.expiryMs,
            state: 'uploading',
            ownerId: decision.ownerId,
            context: decision.context,
        };
        await this.o.store.create(info);
        const headers: Record<string, string> = {
            Location: `${this.o.basePath.replace(/\/+$/, '')}/${info.id}`,
            'Upload-Expires': httpDate(info.expiresAt),
        };
        this.log(`created ${info.id} (${length} bytes)`);
        if (!withBody && length > 0) return this.response(201, headers);

        // creation-with-upload (or an empty upload, complete on creation)
        const lock = await this.lock(info.id, false, 0);
        try {
            Object.assign(headers, withBody ? await this.receive(req, info, lock) : await this.afterWrite(req, info));
        } finally {
            await lock.release();
        }
        return this.response(201, headers);
    }

    // -- HEAD ------------------------------------------------------------------------------------------------------

    private async head(req: Request, id: string): Promise<Response> {
        const info = await this.load(req, id);
        const receiving = info.state === 'uploading';
        const headers: Record<string, string> = {
            'Upload-Offset': String(receiving ? info.offset : info.length),
            'Upload-Length': String(info.length),
            ...this.stateHeaders(info),
        };
        const meta = encodeMetadata(info.metadata);
        if (meta) headers['Upload-Metadata'] = meta;
        if (receiving || info.state === 'complete') headers['Upload-Expires'] = httpDate(info.expiresAt);
        return this.response(200, headers);
    }

    // -- PATCH -----------------------------------------------------------------------------------------------------

    private checkDeclaredLength(req: Request, remaining: number) {
        const cl = req.headers.get('content-length');
        if (cl === null) return;
        const n = parseNonNegInt(cl);
        if (n === null) throw new TusError(400, 'Invalid Content-Length');
        if (n > remaining) throw new TusError(413, 'Request body exceeds the remaining Upload-Length');
    }

    private async patch(req: Request, id: string): Promise<Response> {
        const ct = req.headers.get('content-type');
        if (!ct || ct.split(';')[0].trim().toLowerCase() !== OFFSET_CONTENT_TYPE) {
            throw new TusError(415, `Content-Type must be ${OFFSET_CONTENT_TYPE}`);
        }
        const clientOffset = parseNonNegInt(req.headers.get('upload-offset'));
        if (clientOffset === null) throw new TusError(400, 'Upload-Offset header required');
        parseChecksum(req.headers.get('upload-checksum')); // reject bad/unsupported algorithms before locking

        const lock = await this.lock(id, true);
        try {
            const info = await this.load(req, id);
            if (info.state !== 'uploading') {
                if (clientOffset !== info.length) throw new TusError(409, 'Upload-Offset does not match', undefined, { 'Upload-Offset': String(info.length) });
                return this.response(204, { 'Upload-Offset': String(info.length), ...this.stateHeaders(info) });
            }
            if (clientOffset !== info.offset) {
                throw new TusError(409, 'Upload-Offset does not match the current offset', undefined, { 'Upload-Offset': String(info.offset) });
            }
            this.checkDeclaredLength(req, info.length - info.offset);
            const headers = await this.receive(req, info, lock);
            return this.response(204, headers);
        } finally {
            await lock.release();
        }
    }

    /**
     * Streams the request body into the staging file at info.offset (lock held). Without a checksum, partial bodies
     * (client disconnect, takeover) are kept and the offset persisted; with a checksum a chunk is all-or-nothing.
     */
    private async receive(req: Request, info: TusUploadInfo, lock: HeldLock): Promise<Record<string, string>> {
        const start = info.offset;
        const remaining = info.length - start;
        const checksum = parseChecksum(req.headers.get('upload-checksum'));
        const hash: Hash | null = checksum ? createHash(checksum.algorithm) : null;
        const store = this.o.store;
        let written = 0;
        let persisted = 0;
        let exceeded = false;
        let failure: unknown = null;

        lock.releasable = true;
        const writer = await store.openWriter(info.id, start);
        const reader = req.body?.getReader() ?? null;
        const stop = () => { reader?.cancel(lock.signal.reason).catch(() => undefined); };
        lock.signal.addEventListener('abort', stop);
        try {
            if (lock.signal.aborted) throw lock.signal.reason;
            while (reader) {
                const { value, done } = await reader.read();
                if (lock.signal.aborted) throw lock.signal.reason;
                if (done) break;
                if (!value || !value.length) continue;
                if (written + value.length > remaining) {
                    exceeded = true;
                    await reader.cancel().catch(() => undefined);
                    break;
                }
                hash?.update(value);
                await writer.write(value);
                written += value.length;
                if (!hash && written - persisted >= this.persistEvery) {
                    await writer.flush();
                    if (lock.lost) throw new LockLostError(info.id);
                    info.offset = start + written;
                    info.expiresAt = this.now() + this.o.expiryMs;
                    await store.saveInfo(info);
                    persisted = written;
                }
            }
            await writer.flush();
        } catch (e) {
            failure = e;
            await writer.flush().catch(() => undefined);
        } finally {
            lock.signal.removeEventListener('abort', stop);
            lock.releasable = false;
            await writer.close().catch(() => undefined);
        }

        // Lease lost: another request may own the upload now. Touch nothing.
        if (lock.lost) throw new TusError(423, 'Upload lock lost', undefined, { 'Retry-After': '1' });

        const rollback = async (keepWritten: boolean) => {
            info.offset = keepWritten ? start + written : start;
            if (!keepWritten) await store.truncate(info.id, start);
            info.expiresAt = this.now() + this.o.expiryMs;
            await store.saveInfo(info);
        };
        if (exceeded) {
            await rollback(false);
            throw new TusError(413, 'Request body exceeds the Upload-Length');
        }
        if (failure) {
            await rollback(!hash);
            this.log(`${info.id}: body interrupted at offset ${info.offset} (${failure instanceof Error ? failure.message : failure})`);
            const takeover = lock.signal.aborted;
            throw new TusError(takeover ? 423 : 400, takeover ? 'Superseded by a newer request' : 'Request body interrupted', undefined, {
                'Upload-Offset': String(info.offset),
            });
        }
        if (hash && checksum && !hash.digest().equals(checksum.digest)) {
            await rollback(false);
            throw new TusError(460, 'Checksum Mismatch', undefined, { 'Upload-Offset': String(start) });
        }
        info.offset = start + written;
        info.expiresAt = this.now() + this.o.expiryMs;
        await store.saveInfo(info);
        return this.afterWrite(req, info);
    }

    /** Offset/expiry headers after a successful write; finalizes when the upload is complete. */
    private async afterWrite(req: Request, info: TusUploadInfo): Promise<Record<string, string>> {
        const headers: Record<string, string> = { 'Upload-Offset': String(info.offset) };
        if (info.offset < info.length) {
            headers['Upload-Expires'] = httpDate(info.expiresAt);
            return headers;
        }
        await this.finalize(req, info);
        return { ...headers, ...this.stateHeaders(info) };
    }

    /** Runs the completion hook (lock held) and records the outcome on `info`. */
    private async finalize(req: Request, info: TusUploadInfo): Promise<void> {
        const store = this.o.store;
        info.state = 'finalizing';
        await store.saveInfo(info);
        try {
            const r = await this.o.hooks.onComplete(req, info, store.dataPath(info.id));
            info.state = 'done';
            info.result = { status: 200, body: r.body, headers: r.headers };
            delete info.error;
            info.expiresAt = this.now() + this.retentionMs;
            await store.removeData(info.id);
            await store.saveInfo(info);
            this.log(`${info.id}: finalized`);
        } catch (e) {
            const te = e instanceof TusError ? e
                : new TusError(500, 'Internal server error', { success: false, message: 'Internal server error', code: 'INTERNAL_ERROR' }, {}, true);
            if (!(e instanceof TusError)) this.log(`${info.id}: finalize error: ${e instanceof Error ? e.stack || e.message : e}`);
            const stored: TusStoredResponse = { status: te.status, body: te.body ?? { success: false, message: te.message }, headers: te.headers };
            info.error = stored;
            if (te.retryable) {
                info.state = 'complete';
                info.expiresAt = this.now() + this.o.expiryMs;
            } else {
                info.state = 'failed';
                info.expiresAt = this.now() + this.retentionMs;
                await store.removeData(info.id);
            }
            await store.saveInfo(info);
            this.log(`${info.id}: finalize failed (${te.status}${te.retryable ? ', retryable' : ''})`);
        }
    }

    // -- DELETE (termination) --------------------------------------------------------------------------------------

    private async terminate(req: Request, id: string): Promise<Response> {
        const lock = await this.lock(id, true);
        try {
            await this.load(req, id);
            await this.o.store.remove(id);
            this.log(`${id}: terminated`);
            return this.response(204);
        } finally {
            await lock.release();
        }
    }

    // -- GET (finalize result, not part of tus) --------------------------------------------------------------------

    private resultResponse(info: TusUploadInfo): Response {
        const stored = info.state === 'done' ? info.result : info.error;
        if ((info.state === 'done' || info.state === 'failed') && stored) {
            return this.response(stored.status, { ...stored.headers, ...this.stateHeaders(info) }, stored.body);
        }
        return this.response(202, { [STATE_HEADER]: info.state, 'Retry-After': '1' }, {
            success: false,
            state: info.state,
            offset: info.state === 'uploading' ? info.offset : info.length,
            length: info.length,
            ...(info.error ? { lastError: info.error.body } : {}),
        });
    }

    private async getResult(req: Request, id: string): Promise<Response> {
        let info = await this.load(req, id);
        if (info.state === 'complete' || info.state === 'finalizing') {
            // Retry finalize if nobody is working on it (a live finalize holds the lock and is never interrupted).
            const lock = await this.o.locker.acquire(id, { waitMs: 2_000, requestRelease: false });
            if (lock) {
                try {
                    info = await this.load(req, id);
                    if (info.state === 'complete' || info.state === 'finalizing') await this.finalize(req, info);
                } finally {
                    await lock.release();
                }
            }
            if (info.state === 'complete' && info.error) {
                return this.response(info.error.status, { ...info.error.headers, [STATE_HEADER]: info.state }, info.error.body);
            }
        }
        return this.resultResponse(info);
    }

    // -- Expiration ------------------------------------------------------------------------------------------------

    /**
     * Deletes expired unfinished uploads, result records past their retention and orphaned staging files.
     * Skips uploads whose lock is held (an active request). Returns the number of uploads removed.
     */
    async sweepExpired(): Promise<{ removed: number; orphans: number }> {
        const store = this.o.store;
        const now = this.now();
        let removed = 0;
        for (const id of await store.listIds()) {
            const info = await store.loadInfo(id);
            if (info && info.expiresAt > now) continue;
            const lock = await this.o.locker.acquire(id, { waitMs: 0, requestRelease: false });
            if (!lock) continue;
            try {
                const fresh = await store.loadInfo(id);
                if (fresh && fresh.expiresAt > this.now()) continue;
                await store.remove(id);
                removed++;
            } finally {
                await lock.release();
            }
        }
        let orphans = 0;
        for (const p of await store.orphans(now, Math.max(this.o.expiryMs, 60 * 60_000))) {
            if (await store.removeOrphan(p)) orphans++;
        }
        return { removed, orphans };
    }
}
