import { EventEmitter } from 'events';
import type { KV, MessageHandler, RateWindowResult, Unsubscribe } from './types';
import { createModuleLogger } from '../observability/logger';

const log = createModuleLogger('kv');

/**
 * In-process KV (default when REDIS_URL is unset). Same semantics as RedisKV but only valid for ONE process:
 * a second instance would have its own, disjoint state. Every structure is TTL-bounded and the total number of
 * keys is capped (expired keys swept first, then oldest inserted evicted).
 */

type Entry<T> = { value: T; exp: number };

const DEFAULT_MAX_KEYS = 200_000;

export class MemoryKV implements KV {
    readonly backend = 'memory' as const;
    private strings = new Map<string, Entry<string>>();
    private lists = new Map<string, Entry<string[]>>();
    private zsets = new Map<string, Entry<Map<string, number>>>();
    private windows = new Map<string, Entry<number[]>>();
    private hashes = new Map<string, Entry<Map<string, number>>>();
    private bus = new EventEmitter();
    private timer: ReturnType<typeof setInterval>;

    constructor(private readonly maxKeys = DEFAULT_MAX_KEYS, private readonly now: () => number = Date.now) {
        this.bus.setMaxListeners(0);
        this.timer = setInterval(() => this.sweep(), 30_000);
        (this.timer as { unref?: () => void }).unref?.();
    }

    // ---- helpers -------------------------------------------------------------------------------------------

    private live<T>(map: Map<string, Entry<T>>, key: string): Entry<T> | undefined {
        const e = map.get(key);
        if (!e) return undefined;
        if (e.exp <= this.now()) {
            map.delete(key);
            return undefined;
        }
        return e;
    }

    private put<T>(map: Map<string, Entry<T>>, key: string, value: T, ttlMs: number) {
        if (!map.has(key)) this.ensureRoom(map);
        map.delete(key); // re-insert so Map order approximates recency for eviction
        map.set(key, { value, exp: this.now() + Math.max(1, ttlMs) });
    }

    private ensureRoom<T>(map: Map<string, Entry<T>>) {
        if (map.size < this.maxKeys) return;
        this.sweep();
        while (map.size >= this.maxKeys) {
            const oldest = map.keys().next().value;
            if (oldest === undefined) break;
            map.delete(oldest);
        }
    }

    sweep() {
        const now = this.now();
        for (const map of [this.strings, this.lists, this.zsets, this.windows, this.hashes] as Map<string, Entry<unknown>>[]) {
            for (const [k, e] of map) if (e.exp <= now) map.delete(k);
        }
    }

    // ---- strings -------------------------------------------------------------------------------------------

    async get(key: string) {
        return this.live(this.strings, key)?.value ?? null;
    }

    async set(key: string, value: string, ttlMs: number) {
        this.put(this.strings, key, value, ttlMs);
    }

    async setNX(key: string, value: string, ttlMs: number) {
        if (this.live(this.strings, key)) return false;
        this.put(this.strings, key, value, ttlMs);
        return true;
    }

    async del(key: string) {
        this.strings.delete(key);
        this.lists.delete(key);
        this.zsets.delete(key);
        this.windows.delete(key);
        this.hashes.delete(key);
    }

    async getdel(key: string) {
        const e = this.live(this.strings, key);
        if (!e) return null;
        this.strings.delete(key);
        return e.value;
    }

    async delIfEquals(key: string, value: string) {
        const e = this.live(this.strings, key);
        if (!e || e.value !== value) return false;
        this.strings.delete(key);
        return true;
    }

    async pexpireIfEquals(key: string, value: string, ttlMs: number) {
        const e = this.live(this.strings, key);
        if (!e || e.value !== value) return false;
        e.exp = this.now() + Math.max(1, ttlMs);
        return true;
    }

    // ---- counters ------------------------------------------------------------------------------------------

    async slidingWindow(key: string, limit: number, windowMs: number): Promise<RateWindowResult> {
        const now = this.now();
        const e = this.live(this.windows, key);
        const log = (e?.value ?? []).filter((t) => t > now - windowMs);
        let allowed = false;
        if (log.length < limit) {
            log.push(now);
            allowed = true;
        }
        this.put(this.windows, key, log, windowMs);
        const resetAt = (log[0] ?? now) + windowMs;
        return {
            allowed,
            count: log.length,
            remaining: Math.max(0, limit - log.length),
            resetAt,
            retryAfterMs: allowed ? 0 : Math.max(1, resetAt - now),
        };
    }

    async incrCapped(key: string, amount: number, cap: number, ttlMs: number) {
        const cur = Number(this.live(this.strings, key)?.value ?? '0') || 0;
        const grant = Math.min(Math.floor(amount), Math.floor(cap) - cur);
        if (grant <= 0) return 0;
        this.put(this.strings, key, String(cur + grant), ttlMs);
        return grant;
    }

    // ---- hash counters -------------------------------------------------------------------------------------

    async hIncrBy(key: string, field: string, amount: number, ttlMs: number) {
        const h = this.live(this.hashes, key)?.value ?? new Map<string, number>();
        const next = (h.get(field) ?? 0) + Math.trunc(amount);
        h.set(field, next);
        this.put(this.hashes, key, h, ttlMs);
        return next;
    }

    async hGet(key: string, field: string) {
        return this.live(this.hashes, key)?.value.get(field) ?? 0;
    }

    async hDrain(key: string) {
        const e = this.live(this.hashes, key);
        this.hashes.delete(key);
        return e ? Object.fromEntries(e.value) : {};
    }

    // ---- lists ---------------------------------------------------------------------------------------------

    async listPush(key: string, value: string, maxLen: number, ttlMs: number) {
        const items = this.live(this.lists, key)?.value ?? [];
        items.push(value);
        if (items.length > maxLen) items.splice(0, items.length - maxLen);
        this.put(this.lists, key, items, ttlMs);
        return items.length;
    }

    async listDrain(key: string) {
        const e = this.live(this.lists, key);
        this.lists.delete(key);
        return e ? e.value : [];
    }

    // ---- live sets -----------------------------------------------------------------------------------------

    async zAddCapped(key: string, member: string, score: number, minScore: number, maxCard: number, ttlMs: number) {
        const z = this.live(this.zsets, key)?.value ?? new Map<string, number>();
        for (const [m, s] of z) if (s < minScore) z.delete(m);
        if (!z.has(member) && z.size >= maxCard) {
            if (z.size > 0) this.put(this.zsets, key, z, ttlMs);
            return false;
        }
        z.set(member, score);
        this.put(this.zsets, key, z, ttlMs);
        return true;
    }

    async zMembers(key: string, minScore: number) {
        const z = this.live(this.zsets, key)?.value;
        if (!z) return [];
        return [...z].filter(([, s]) => s >= minScore).sort((a, b) => a[1] - b[1]).map(([m]) => m);
    }

    async zRem(key: string, member: string) {
        this.live(this.zsets, key)?.value.delete(member);
    }

    // ---- pub/sub -------------------------------------------------------------------------------------------

    async publish(channel: string, message: string) {
        // Async delivery, like Redis: never re-enters the publisher synchronously.
        queueMicrotask(() => this.bus.emit(channel, message));
    }

    async subscribe(channel: string, handler: MessageHandler): Promise<Unsubscribe> {
        const fn = (m: string) => {
            try {
                handler(m);
            } catch (e) {
                log.error({ err: e }, 'subscriber error');
            }
        };
        this.bus.on(channel, fn);
        return async () => {
            this.bus.off(channel, fn);
        };
    }

    async close() {
        clearInterval(this.timer);
        this.bus.removeAllListeners();
    }
}
