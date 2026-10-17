/**
 * Byte-bounded LRU cache with per-entry TTL and a separate sub-budget for prefetched entries (pure).
 *
 * - LRU via Map insertion order; total bytes ≤ maxBytes; items > maxItemBytes are never cached.
 * - Entries are tagged with their source. Prefetched entries ('predicted' | 'successor' | 'intent') that have not
 *   been hit yet count against prefetchMaxBytes; inserting one first evicts older unhit prefetched entries, so
 *   prefetch can never take more than its share. The first hit "promotes" the entry (it is now demand data) and is
 *   attributed to its source.
 * - A prefetch for a key that is already cached only extends its TTL.
 */

export type CacheSource = 'demand' | 'predicted' | 'successor' | 'intent';

export interface CacheEntry<V extends { length: number } = Uint8Array> {
    value: V;
    engine: string;
    source: CacheSource;
    insertedAt: number;
    expiresAt: number;
    hits: number;
    /** Prefetched entry that has been hit at least once. */
    promoted: boolean;
}

export interface ByteCacheOptions {
    maxBytes: number;
    maxItemBytes: number;
    prefetchMaxBytes: number;
}

export interface ByteCacheStats {
    entries: number;
    bytes: number;
    maxBytes: number;
    prefetchBytes: number;
    prefetchMaxBytes: number;
    prefetchInserted: Record<string, number>;
    /** First hit on a prefetched entry, by source. */
    prefetchHits: Record<string, number>;
    /** Prefetched entries evicted or expired without ever being hit, by source. */
    prefetchWasted: Record<string, number>;
    prefetchBytesInserted: number;
    evictions: number;
}

const isPrefetch = (s: CacheSource) => s !== 'demand';

export class ByteLruCache<V extends { length: number } = Uint8Array> {
    readonly opts: ByteCacheOptions;
    private map = new Map<string, CacheEntry<V>>();
    private bytes = 0;
    private prefetchBytes = 0;
    private counters = {
        prefetchInserted: {} as Record<string, number>,
        prefetchHits: {} as Record<string, number>,
        prefetchWasted: {} as Record<string, number>,
        prefetchBytesInserted: 0,
        evictions: 0,
    };

    constructor(opts: ByteCacheOptions) {
        this.opts = {
            maxBytes: Math.max(0, opts.maxBytes),
            maxItemBytes: Math.max(0, opts.maxItemBytes),
            prefetchMaxBytes: Math.max(0, Math.min(opts.prefetchMaxBytes, opts.maxBytes)),
        };
    }

    private unhitPrefetch(e: CacheEntry<V>) {
        return isPrefetch(e.source) && !e.promoted;
    }

    private remove(key: string, wasted: boolean) {
        const e = this.map.get(key);
        if (!e) return;
        this.map.delete(key);
        this.bytes -= e.value.length;
        if (this.unhitPrefetch(e)) {
            this.prefetchBytes -= e.value.length;
            if (wasted) this.counters.prefetchWasted[e.source] = (this.counters.prefetchWasted[e.source] || 0) + 1;
        }
    }

    delete(key: string) {
        this.remove(key, false);
    }

    /** Lookup without side effects (no LRU refresh, no hit accounting). Expired entries read as absent. */
    peek(key: string, now: number): CacheEntry<V> | null {
        const e = this.map.get(key);
        return e && now <= e.expiresAt ? e : null;
    }

    has(key: string, now: number): boolean {
        return this.peek(key, now) !== null;
    }

    /** Lookup for serving: refreshes LRU, counts hits, promotes prefetched entries on first hit. */
    get(key: string, now: number, demandTtlMs?: number): CacheEntry<V> | null {
        const e = this.map.get(key);
        if (!e) return null;
        if (now > e.expiresAt) {
            this.remove(key, true);
            return null;
        }
        this.map.delete(key);
        this.map.set(key, e);
        e.hits++;
        if (this.unhitPrefetch(e)) {
            e.promoted = true;
            this.prefetchBytes -= e.value.length;
            this.counters.prefetchHits[e.source] = (this.counters.prefetchHits[e.source] || 0) + 1;
        }
        if (demandTtlMs !== undefined) e.expiresAt = Math.max(e.expiresAt, now + demandTtlMs);
        return e;
    }

    /** Extends an entry's TTL (never shortens). Returns false if absent/expired. */
    extend(key: string, until: number, now: number): boolean {
        const e = this.peek(key, now);
        if (!e) return false;
        e.expiresAt = Math.max(e.expiresAt, until);
        return true;
    }

    /** Removes every expired entry. */
    sweep(now: number) {
        for (const [k, e] of this.map) if (now > e.expiresAt) this.remove(k, true);
    }

    set(key: string, value: V, engine: string, now: number, opts: { source?: CacheSource; ttlMs: number }): boolean {
        const source = opts.source ?? 'demand';
        const len = value.length;
        if (len === 0 || len > this.opts.maxItemBytes || len > this.opts.maxBytes) return false;
        this.sweep(now);

        const existing = this.map.get(key);
        if (existing && isPrefetch(source)) {
            // Already resident (demand or prefetched): keep it, just make it live long enough.
            existing.expiresAt = Math.max(existing.expiresAt, now + opts.ttlMs);
            return true;
        }
        if (existing) this.remove(key, false);

        if (isPrefetch(source)) {
            if (len > this.opts.prefetchMaxBytes) return false;
            for (const [k, e] of this.map) {
                if (this.prefetchBytes + len <= this.opts.prefetchMaxBytes) break;
                if (this.unhitPrefetch(e)) { this.remove(k, true); this.counters.evictions++; }
            }
            if (this.prefetchBytes + len > this.opts.prefetchMaxBytes) return false;
        }
        while (this.bytes + len > this.opts.maxBytes && this.map.size > 0) {
            const oldest = this.map.keys().next().value as string;
            this.remove(oldest, true);
            this.counters.evictions++;
        }

        this.map.set(key, { value, engine, source, insertedAt: now, expiresAt: now + opts.ttlMs, hits: 0, promoted: false });
        this.bytes += len;
        if (isPrefetch(source)) {
            this.prefetchBytes += len;
            this.counters.prefetchInserted[source] = (this.counters.prefetchInserted[source] || 0) + 1;
            this.counters.prefetchBytesInserted += len;
        }
        return true;
    }

    stats(): ByteCacheStats {
        return {
            entries: this.map.size,
            bytes: this.bytes,
            maxBytes: this.opts.maxBytes,
            prefetchBytes: this.prefetchBytes,
            prefetchMaxBytes: this.opts.prefetchMaxBytes,
            prefetchInserted: { ...this.counters.prefetchInserted },
            prefetchHits: { ...this.counters.prefetchHits },
            prefetchWasted: { ...this.counters.prefetchWasted },
            prefetchBytesInserted: this.counters.prefetchBytesInserted,
            evictions: this.counters.evictions,
        };
    }
}
