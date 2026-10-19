import * as tus from 'tus-js-client';

/**
 * Thin promise wrapper around tus-js-client for /api/uploads (browser and Node; relative imports only so the live
 * tests can drive it from Node).
 *
 *  - Resume: uploads are fingerprinted and their URL kept in `urlStorage` (localStorage in browsers), so the same
 *    file resumes after a page reload; network drops are retried automatically with backoff (`retryDelays`).
 *  - Secrets: `password` is stripped from the metadata tus-js-client stores for resuming.
 *  - Result: the final PATCH (or the HEAD of an already complete upload) carries `Diocom-Share-Link`; when it does
 *    not (finalize still running or being retried), GET <upload url> is polled for `{ success, link, stats }`.
 */

export const TUS_ENDPOINT = '/api/uploads';
export const DEFAULT_RETRY_DELAYS = [0, 1_000, 3_000, 5_000, 10_000, 20_000, 30_000, 60_000];
const SECRET_METADATA_KEYS = ['password'];

export interface TusUploadOutcome {
    status: number;
    /** `{ success, link, stats }` (same shape as POST /api/ingest), or an error body. */
    data: { success?: boolean; link?: string; message?: string; code?: string; stats?: unknown } | null;
    uploadUrl: string;
    /** Offset the upload resumed from (null: fresh upload). */
    resumedFrom: number | null;
}

export interface TusUploadOptions {
    /** Absolute in Node; may be relative in browsers. */
    endpoint: string;
    /** File/Blob/Buffer, or whatever `fileReader` understands. */
    source: unknown;
    /** Total bytes (Upload-Length). */
    size: number;
    metadata: Record<string, string>;
    /** Stable id of this source for resuming (same file -> same fingerprint). */
    fingerprint: string;
    chunkSize?: number;
    retryDelays?: number[];
    fileReader?: tus.UploadOptions['fileReader'];
    urlStorage?: tus.UrlStorage;
    httpStack?: tus.HttpStack;
    headers?: Record<string, string>;
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
    /** fetch used for GET <upload url> (default: global fetch). */
    fetchImpl?: typeof fetch;
}

/** Error with the HTTP status of the failed tus request (null: network / client error). */
export class TusUploadError extends Error {
    constructor(message: string, readonly status: number | null, readonly body: string | null, readonly started: boolean) {
        super(message);
        this.name = 'TusUploadError';
    }
}

function stripSecrets(meta: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(meta || {})) if (!SECRET_METADATA_KEYS.includes(k)) out[k] = v;
    return out;
}

/** Wraps a URL storage so secrets in the metadata are never persisted. */
export function secretFreeUrlStorage(inner: tus.UrlStorage): tus.UrlStorage {
    return {
        findAllUploads: () => inner.findAllUploads(),
        findUploadsByFingerprint: (fp) => inner.findUploadsByFingerprint(fp),
        removeUpload: (key) => inner.removeUpload(key),
        addUpload: (fp, upload) => inner.addUpload(fp, { ...upload, metadata: stripSecrets(upload.metadata) }),
    };
}

/** In-memory URL storage (Node / tests). */
export class MemoryUrlStorage implements tus.UrlStorage {
    readonly entries = new Map<string, tus.PreviousUpload & { fingerprint: string }>();
    private seq = 0;
    async findAllUploads() { return [...this.entries.values()]; }
    async findUploadsByFingerprint(fp: string) { return [...this.entries.values()].filter((e) => e.fingerprint === fp); }
    async removeUpload(key: string) { this.entries.delete(key); }
    async addUpload(fp: string, upload: tus.PreviousUpload) {
        const key = `tus::${fp}::${++this.seq}`;
        this.entries.set(key, { ...upload, urlStorageKey: key, fingerprint: fp });
        return key;
    }
}

function resolveUrl(url: string, base: string): string {
    try {
        return new URL(url, base).toString();
    } catch {
        return url;
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls GET <upload url> until the finalize result is available. */
async function fetchResult(uploadUrl: string, fetchImpl: typeof fetch, headers?: Record<string, string>): Promise<{ status: number; data: TusUploadOutcome['data'] }> {
    let last: { status: number; data: TusUploadOutcome['data'] } = { status: 0, data: null };
    for (let attempt = 0; attempt < 60; attempt++) {
        let res: Response;
        try {
            res = await fetchImpl(uploadUrl, { method: 'GET', headers, cache: 'no-store', credentials: 'same-origin' });
        } catch {
            await sleep(Math.min(1_000 * 2 ** attempt, 10_000));
            continue;
        }
        const data = await res.json().catch(() => null) as TusUploadOutcome['data'];
        last = { status: res.status, data };
        // 202: still uploading/finalizing; 503: backend briefly unavailable (finalize is retried on the next GET).
        if (res.status !== 202 && res.status !== 503) return last;
        const ra = Number(res.headers.get('retry-after'));
        await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 1000, res.status === 503 ? 15_000 : 2_000));
    }
    return last;
}

/** Uploads (or resumes) one source via tus and resolves with the finalize result. */
export function tusUpload(o: TusUploadOptions): Promise<TusUploadOutcome> {
    const fetchImpl = o.fetchImpl ?? globalThis.fetch.bind(globalThis);
    const base = typeof window !== 'undefined' ? window.location.href : o.endpoint;
    const endpoint = resolveUrl(o.endpoint, base);
    return new Promise<TusUploadOutcome>((resolve, reject) => {
        let resumedFrom: number | null = null;
        let settled = false;
        let started = false;
        const fail = (e: unknown) => {
            if (settled) return;
            settled = true;
            const de = e as tus.DetailedError;
            const status = de?.originalResponse?.getStatus?.() ?? null;
            const body = de?.originalResponse?.getBody?.() ?? null;
            reject(new TusUploadError(e instanceof Error ? e.message : String(e), status || null, body, started));
        };
        const options: tus.UploadOptions = {
            endpoint,
            metadata: o.metadata,
            uploadSize: o.size,
            chunkSize: o.chunkSize ?? 32 * 1024 * 1024,
            retryDelays: o.retryDelays ?? DEFAULT_RETRY_DELAYS,
            fingerprint: async () => o.fingerprint,
            storeFingerprintForResuming: true,
            removeFingerprintOnSuccess: true,
            headers: o.headers,
            onUploadUrlAvailable: () => { started = true; },
            onProgress: (sent, total) => {
                if (resumedFrom === 0 && sent > 0) resumedFrom = sent; // first progress after the resume HEAD
                o.onProgress?.(sent, total);
            },
            onError: fail,
            onSuccess: ({ lastResponse }) => {
                const uploadUrl = resolveUrl(upload.url ?? '', endpoint);
                const link = lastResponse.getHeader('Diocom-Share-Link');
                const finish = async () => {
                    if (link) return { status: 200, data: { success: true, link } };
                    return fetchResult(uploadUrl, fetchImpl, o.headers);
                };
                finish().then(
                    async (r) => {
                        if (settled) return;
                        // The final response only carries the link; the stats come with GET (best effort).
                        if (link && r.data && !r.data.stats) {
                            const full = await fetchResult(uploadUrl, fetchImpl, o.headers).catch(() => null);
                            if (full?.status === 200 && full.data?.link === link) r = full;
                        }
                        settled = true;
                        resolve({ status: r.status, data: r.data, uploadUrl, resumedFrom });
                    },
                    fail,
                );
            },
        };
        if (o.fileReader) options.fileReader = o.fileReader;
        if (o.httpStack) options.httpStack = o.httpStack;
        options.urlStorage = secretFreeUrlStorage(o.urlStorage ?? tus.defaultOptions.urlStorage);
        const upload = new tus.Upload(o.source as Blob, options);
        o.signal?.addEventListener('abort', () => {
            upload.abort(false).catch(() => undefined);
            fail(new Error('Upload aborted'));
        }, { once: true });
        upload.findPreviousUploads().then(
            (previous) => {
                const prev = previous.find((p) => p.size === o.size && p.uploadUrl);
                if (prev) {
                    resumedFrom = 0; // refined by the first progress event after the HEAD (onProgress)
                    upload.resumeFromPreviousUpload(prev);
                }
                upload.start();
            },
            () => upload.start(),
        );
    });
}

/** Deletes a stored (unfinished) upload on the server and forgets it locally. Best effort. */
export async function forgetStoredUploads(fingerprint: string, urlStorage: tus.UrlStorage = tus.defaultOptions.urlStorage, endpoint = TUS_ENDPOINT): Promise<void> {
    const base = typeof window !== 'undefined' ? window.location.href : endpoint;
    let previous: tus.PreviousUpload[] = [];
    try { previous = await urlStorage.findUploadsByFingerprint(fingerprint); } catch { return; }
    for (const p of previous) {
        if (p.uploadUrl) await tus.Upload.terminate(resolveUrl(p.uploadUrl, base), { retryDelays: [] }).catch(() => undefined);
        await urlStorage.removeUpload(p.urlStorageKey).catch(() => undefined);
    }
}
