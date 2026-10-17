/**
 * Shared key/value store used for all state that must be consistent across app instances
 * (rate limits, single-use tokens, WebAuthn challenges, swarm signaling, upload progress, job locks).
 *
 * Two implementations with identical semantics:
 *  - RedisKV  (REDIS_URL set): every multi-step operation is a single Lua script or MULTI transaction.
 *  - MemoryKV (default, dev / single instance): plain in-process maps; atomic because JS is single-threaded.
 *
 * Keys are strings; values are strings (callers JSON-encode). TTLs are milliseconds and are always required for
 * writes so nothing is stored forever by accident.
 */

export interface RateWindowResult {
    allowed: boolean;
    /** Requests counted in the current window (including this one when allowed). */
    count: number;
    remaining: number;
    /** Epoch ms at which the oldest counted request leaves the window (a slot frees up). */
    resetAt: number;
    /** 0 when allowed; otherwise ms until a slot frees up. */
    retryAfterMs: number;
}

export type Unsubscribe = () => Promise<void>;
export type MessageHandler = (message: string) => void;

export interface KV {
    readonly backend: 'redis' | 'memory';

    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlMs: number): Promise<void>;
    /** SET NX PX. True when the key did not exist and was written. */
    setNX(key: string, value: string, ttlMs: number): Promise<boolean>;
    del(key: string): Promise<void>;
    /** Atomic read-and-delete (Redis GETDEL): of N concurrent callers at most one gets the value. */
    getdel(key: string): Promise<string | null>;
    /** Deletes the key only if it currently holds `value` (compare-and-delete). */
    delIfEquals(key: string, value: string): Promise<boolean>;
    /** Resets the TTL only if the key currently holds `value`. */
    pexpireIfEquals(key: string, value: string, ttlMs: number): Promise<boolean>;

    /**
     * Sliding-window-log rate limit: at most `limit` accepted events in any `windowMs` interval.
     * Rejected attempts are not counted. Atomic (Lua; Redis server clock, so instance clock skew does not matter).
     */
    slidingWindow(key: string, limit: number, windowMs: number): Promise<RateWindowResult>;

    /** Atomically adds min(amount, cap - current) to an integer counter; returns the amount actually added (>= 0). */
    incrCapped(key: string, amount: number, cap: number, ttlMs: number): Promise<number>;

    /** Appends to a bounded list (oldest dropped beyond maxLen) and resets its TTL. Returns the new length. */
    listPush(key: string, value: string, maxLen: number, ttlMs: number): Promise<number>;
    /** Atomically returns and deletes the whole list. */
    listDrain(key: string): Promise<string[]>;

    /**
     * Bounded "live set" (sorted set scored by time): drops members with score < minScore, then upserts `member`
     * unless that would exceed maxCard (existing members are always refreshed). Returns false when full.
     */
    zAddCapped(key: string, member: string, score: number, minScore: number, maxCard: number, ttlMs: number): Promise<boolean>;
    /** Members with score >= minScore. */
    zMembers(key: string, minScore: number): Promise<string[]>;
    zRem(key: string, member: string): Promise<void>;

    /** Fire-and-forget broadcast to every instance subscribed to `channel` (including this one). */
    publish(channel: string, message: string): Promise<void>;
    subscribe(channel: string, handler: MessageHandler): Promise<Unsubscribe>;

    close(): Promise<void>;
}
