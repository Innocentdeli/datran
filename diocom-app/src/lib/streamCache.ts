import fs from 'fs';
import type { FileRecord } from '@/db/files';
import { resolveStoredPath } from '@/lib/storage';
import { decompressPayload } from '@/lib/reactorWorker';
import { ByteLruCache, CacheSource } from '@/lib/predict/byteCache';
import { parseReactorStoragePath } from '@/lib/storage/reactorStoreCore';
import { readStoreFile } from '@/lib/storage/reactorStore';
import { observeReactorCall } from '@/lib/observability/metrics';

/**
 * Shared decompression cache for /api/stream and the prefetcher (NETWORK_SPEC §5).
 *
 * Bounded by STREAM_CACHE_MAX_BYTES (LRU); items larger than a quarter of the cache are served but never cached.
 * Prefetched entries are tagged by source and limited to PREFETCH_MAX_BYTES (default 25% of the cache) until their
 * first hit. The singleton lives on globalThis because route handlers and instrumentation are separate bundles.
 *
 * Caching only stores decoded bytes: every request still goes through the route's DB lookup, expiry and
 * password/access checks before the cache is consulted.
 */

export const DEMAND_TTL_MS = 90_000;

function envInt(name: string, fallback: number, min = 0): number {
    const n = parseInt(process.env[name] || '', 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
}

export function streamCacheMaxBytes(): number {
    return envInt('STREAM_CACHE_MAX_BYTES', 256 * 1024 * 1024);
}

export function prefetchMaxBytes(): number {
    const max = streamCacheMaxBytes();
    return Math.min(envInt('PREFETCH_MAX_BYTES', Math.floor(max / 4)), max);
}

type Holder = {
    __diocomStreamCache?: ByteLruCache<Buffer>;
    __diocomStreamInflight?: Map<string, Promise<DecodedFile>>;
};
const g = globalThis as typeof globalThis & Holder;

export function getStreamCache(): ByteLruCache<Buffer> {
    if (!g.__diocomStreamCache) {
        const maxBytes = streamCacheMaxBytes();
        g.__diocomStreamCache = new ByteLruCache<Buffer>({
            maxBytes,
            maxItemBytes: Math.floor(maxBytes / 4),
            prefetchMaxBytes: prefetchMaxBytes(),
        });
    }
    return g.__diocomStreamCache;
}

function inflight(): Map<string, Promise<DecodedFile>> {
    if (!g.__diocomStreamInflight) g.__diocomStreamInflight = new Map();
    return g.__diocomStreamInflight;
}

/** True when the stored object is reactor/TS-compressed (served from a decoded buffer, hence cacheable). */
export function isCompressedRecord(r: Pick<FileRecord, 'compression_ratio'>): boolean {
    return !!(
        r.compression_ratio &&
        r.compression_ratio !== '1.0x' &&
        r.compression_ratio !== '1.0x (Fast-path)'
    );
}

/** True when the record's bytes live in the reactor chunked object store (`storage_path = reactor:<file_id>`). */
export function isReactorRecord(r: Pick<FileRecord, 'storage_path'>): boolean {
    return parseReactorStoragePath(r.storage_path) !== null;
}

/**
 * Files the prefetcher may warm: reactor-store files (warming = a reactor GET so gravity sees the demand, bytes cached
 * when they fit) and locally stored compressed files (decoded bytes cached).
 */
export function isCacheableRecord(r: Pick<FileRecord, 'compression_ratio' | 'is_external' | 'storage_path'>): boolean {
    if (isReactorRecord(r)) return true;
    return Number(r.is_external) !== 1 && isCompressedRecord(r);
}

export interface DecodedFile {
    data: Buffer;
    engine: string;
}

export class StoredContentMissingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'StoredContentMissingError';
    }
}

/**
 * Loads the plaintext of a stored file: reactor-store files are read from the reactor (which verifies every chunk
 * hash; the read also counts as demand for data gravity), local files are read from disk and decoded (Rust reactor,
 * TS fallback). Concurrent calls for the same file share one load (a request arriving while the prefetcher loads
 * waits for that result). Throws StoredContentMissingError, DictionaryUnavailableError or decode errors.
 */
export function decodeStoredFile(record: Pick<FileRecord, 'share_id' | 'storage_path'>): Promise<DecodedFile> {
    const key = record.share_id;
    const running = inflight().get(key);
    if (running) return running;
    const p = (async (): Promise<DecodedFile> => {
        const storeId = parseReactorStoragePath(record.storage_path);
        if (storeId) {
            const data = await observeReactorCall('store_read', () => readStoreFile(storeId, streamCacheMaxBytes()));
            if (!data) throw new StoredContentMissingError('file is not held by the reactor store');
            return { data, engine: 'reactor_store' };
        }
        const filePath = resolveStoredPath(record.storage_path);
        if (!filePath) throw new StoredContentMissingError('stored path is outside the storage root');
        let diskBuffer: Buffer;
        try {
            diskBuffer = await fs.promises.readFile(filePath);
        } catch {
            throw new StoredContentMissingError('stored object is missing');
        }
        return decompressPayload(diskBuffer);
    })();
    inflight().set(key, p);
    p.finally(() => inflight().delete(key)).catch(() => { });
    return p;
}

/** Inserts decoded bytes; returns false when the item is too large or (for prefetch) over the prefetch budget. */
export function cacheDecoded(shareId: string, decoded: DecodedFile, source: CacheSource, ttlMs: number): boolean {
    return getStreamCache().set(shareId, decoded.data, decoded.engine, Date.now(), { source, ttlMs });
}
