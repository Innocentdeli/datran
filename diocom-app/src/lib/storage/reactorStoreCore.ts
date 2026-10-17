/**
 * Pure helpers for the reactor chunked object store integration (core-reactor/docs/NETWORK_SPEC.md §2).
 * No Next.js / '@/' imports: unit-tested from the repo root (tests/reactor_store_app.test.ts).
 *
 * Records whose content lives in the reactor store keep `storage_path = "reactor:<file_id>"`, where file_id is the
 * lowercase hex SHA-256 of the plaintext (the store's content address). No schema change is needed, so this works
 * unchanged on PostgreSQL and the local JSON emulator; legacy local paths / S3 URLs never match the prefix.
 */

export type StorageBackend = 'reactor' | 'local' | 's3';

export const REACTOR_PATH_PREFIX = 'reactor:';
const FILE_ID = /^[0-9a-f]{64}$/;

/**
 * STORAGE_BACKEND=reactor|local|s3. Unset/invalid keeps the historic behaviour: s3 when CDN_ENABLED=true, else local.
 */
export function resolveStorageBackend(env: Record<string, string | undefined>): StorageBackend {
    const v = (env.STORAGE_BACKEND || '').trim().toLowerCase();
    if (v === 'reactor' || v === 'local' || v === 's3') return v;
    return env.CDN_ENABLED === 'true' ? 's3' : 'local';
}

export function isValidStoreFileId(id: unknown): id is string {
    return typeof id === 'string' && FILE_ID.test(id);
}

export function toReactorStoragePath(fileId: string): string {
    const id = String(fileId).toLowerCase();
    if (!FILE_ID.test(id)) throw new Error('Invalid reactor store file id');
    return `${REACTOR_PATH_PREFIX}${id}`;
}

/** Returns the store file id for a `reactor:<sha256>` storage path, or null for anything else (legacy paths, URLs). */
export function parseReactorStoragePath(p: unknown): string | null {
    if (typeof p !== 'string' || !p.startsWith(REACTOR_PATH_PREFIX)) return null;
    const id = p.slice(REACTOR_PATH_PREFIX.length).toLowerCase();
    return FILE_ID.test(id) ? id : null;
}

export function isReactorStoragePath(p: unknown): boolean {
    return parseReactorStoragePath(p) !== null;
}

/**
 * Client Range header to forward to the reactor. Only plausible `bytes=` specs (digits, '-', ',', spaces) are sent;
 * the reactor itself applies the RFC 9110 rules (single range, suffix, 416; multi-range ignored -> 200).
 */
export function forwardableRange(h: string | null | undefined): string | null {
    if (!h) return null;
    const v = h.trim();
    if (v.length > 200 || !/^bytes=[\d\s,-]+$/i.test(v)) return null;
    return v;
}

export interface HeaderSource { get(name: string): string | null }

export type ProxyMapping =
    | { kind: 'pass'; status: 200 | 206 | 416; headers: Record<string, string> }
    | { kind: 'missing' }
    | { kind: 'error'; upstreamStatus: number };

const PASS_HEADERS: Array<[string, string]> = [
    ['content-range', 'Content-Range'],
    ['content-length', 'Content-Length'],
    ['accept-ranges', 'Accept-Ranges'],
    ['etag', 'ETag'],
];

/**
 * Maps a reactor GET /store/files/:id response onto the app response. Range semantics (206/416, Content-Range,
 * Content-Length, Accept-Ranges, ETag) come from the reactor; the app's own headers (Content-Type, nosniff,
 * Content-Disposition, Cache-Control) win over anything the reactor sends (it always says application/octet-stream).
 */
export function mapReactorResponse(status: number, upstream: HeaderSource, appHeaders: Record<string, string>): ProxyMapping {
    if (status === 404) return { kind: 'missing' };
    if (status !== 200 && status !== 206 && status !== 416) return { kind: 'error', upstreamStatus: status };
    const headers: Record<string, string> = {};
    for (const [lower, canonical] of PASS_HEADERS) {
        const v = upstream.get(lower);
        if (v !== null && v !== undefined && v !== '' && !/[\r\n]/.test(v)) headers[canonical] = v;
    }
    for (const [k, v] of Object.entries(appHeaders)) {
        // Accept-Ranges is part of the app's base headers too; prefer the reactor's value when it sent one.
        if (k.toLowerCase() === 'accept-ranges' && headers['Accept-Ranges']) continue;
        headers[k] = v;
    }
    if (status === 416 && !headers['Content-Length']) headers['Content-Length'] = '0';
    return { kind: 'pass', status, headers };
}

/**
 * Download/access counting rule shared with the legacy paths: full responses and ranges starting at byte 0 count;
 * continuations (seeking, resumed downloads) and 416 do not.
 */
export function isCountedAccess(status: number, contentRange: string | null): boolean {
    if (status === 200) return true;
    if (status !== 206 || !contentRange) return false;
    return /^bytes\s+0-\d+\/(\d+|\*)$/i.test(contentRange.trim());
}

export interface StorePutResult {
    file_id: string;
    size: number;
    stored_bytes: number;
    /** Plaintext bytes of the newly stored chunks; null from reactors that predate the field. */
    new_bytes: number | null;
    new_chunks: number;
    dedup_chunks: number;
    chunks: number | null;
    class: string | null;
    duplicate: boolean;
    pins: number | null;
}

const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/** Validates the PUT /store/files JSON body; throws on anything unusable. */
export function parseStorePutResult(body: unknown): StorePutResult {
    if (!body || typeof body !== 'object') throw new Error('store returned a non-object');
    const b = body as Record<string, unknown>;
    const id = typeof b.file_id === 'string' ? b.file_id.toLowerCase() : '';
    if (!FILE_ID.test(id)) throw new Error('store returned an invalid file_id');
    const size = n(b.size);
    if (size === null) throw new Error('store returned an invalid size');
    const cls = typeof b.class === 'string' && b.class.length <= 64 && /^[A-Za-z0-9._+\-/]+$/.test(b.class) ? b.class : null;
    return {
        file_id: id,
        size,
        stored_bytes: n(b.stored_bytes) ?? 0,
        new_bytes: n(b.new_bytes),
        new_chunks: n(b.new_chunks) ?? 0,
        dedup_chunks: n(b.dedup_chunks) ?? 0,
        chunks: n(b.chunks),
        class: cls,
        duplicate: b.duplicate === true,
        pins: n(b.pins),
    };
}

export interface StoreRatios {
    /**
     * Compression of this file's NEW chunks: plaintext bytes of new chunks / bytes they occupy on disk. null when no
     * new chunk was written (full dedup) or it can't be computed.
     */
    compression: number | null;
    /**
     * True when the plaintext size of the new chunks had to be estimated. Current reactors report it (`new_bytes`), so
     * this is only true for older reactors with partial dedup: new-chunk bytes ≈ size × new_chunks / chunks.
     */
    compressionEstimated: boolean;
    /** Percentage of this file's chunks that were already stored (cross-file or repeated within the file). */
    dedupPercent: number | null;
}

type RatioInput = Pick<StorePutResult, 'size' | 'stored_bytes' | 'duplicate' | 'new_chunks' | 'dedup_chunks' | 'chunks'> & {
    new_bytes?: number | null;
};

/**
 * Honest per-upload figures for a store PUT. The old single "size / bytes added" ratio mixed compression with dedup
 * (a mostly-deduplicated file showed e.g. 167×); these keep the two apart.
 */
export function computeStoreRatios(r: RatioInput): StoreRatios {
    const total = r.chunks !== null && r.chunks > 0 ? r.chunks : r.new_chunks + r.dedup_chunks;
    if (r.size === 0 || total === 0) return { compression: null, compressionEstimated: false, dedupPercent: null };
    const newChunks = r.duplicate ? 0 : Math.min(r.new_chunks, total);
    const dedupPercent = ((total - newChunks) / total) * 100;
    if (newChunks === 0 || r.stored_bytes <= 0) return { compression: null, compressionEstimated: false, dedupPercent };
    if (typeof r.new_bytes === 'number' && r.new_bytes > 0) {
        return { compression: r.new_bytes / r.stored_bytes, compressionEstimated: false, dedupPercent };
    }
    const exact = newChunks === total;
    const newBytes = exact ? r.size : (r.size * newChunks) / total;
    return { compression: newBytes / r.stored_bytes, compressionEstimated: !exact, dedupPercent };
}

function pct(p: number): string {
    if (p > 0 && p < 1) return '<1%';
    if (p < 100 && p > 99) return '>99%';
    return `${Math.round(p)}%`;
}

/**
 * Display label stored in files.compression_ratio and returned as stats.ratio, e.g. "2.50x compressed",
 * "1.80x compressed · 40% dedup", "~1.80x …" (estimated, older reactors only) or "100% dedup". Never returns the
 * legacy '1.0x' marker.
 */
export function formatStoreRatio(r: RatioInput): string {
    if (r.size === 0) return 'empty';
    const { compression, compressionEstimated, dedupPercent } = computeStoreRatios(r);
    const parts: string[] = [];
    if (compression !== null) parts.push(`${compressionEstimated ? '~' : ''}${compression.toFixed(2)}x compressed`);
    if (dedupPercent !== null && dedupPercent > 0) parts.push(`${pct(dedupPercent)} dedup`);
    return parts.length ? parts.join(' · ') : 'dedup';
}

/** User-facing message for a 507 from the store. */
export function storeFullMessage(body: unknown): string {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const mib = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `${(v / (1024 * 1024)).toFixed(1)} MiB` : null);
    const used = mib(b.used);
    const max = mib(b.max);
    return `Storage is full: the server cannot accept this file right now${used && max ? ` (${used} of ${max} used)` : ''}. Try again later or upload a smaller file.`;
}
