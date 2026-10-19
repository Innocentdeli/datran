import { randomBytes } from 'crypto';
import type { KV } from './types';
import { MemoryKV } from './memory';
import { RedisKV } from './redis';
import { createModuleLogger } from '../observability/logger';

const kvLog = createModuleLogger('kv');

export type { KV, RateWindowResult, Unsubscribe, MessageHandler } from './types';
export { MemoryKV } from './memory';
export { RedisKV } from './redis';

/**
 * Process-wide KV singleton.
 *
 *   REDIS_URL set      -> Redis (required for more than one app instance behind a load balancer).
 *   REDIS_URL unset    -> in-memory. In production this logs a prominent warning: run exactly ONE instance.
 *   REQUIRE_REDIS=true -> refuse to start without REDIS_URL.
 *   KV_PREFIX          -> key/channel namespace (default "diocom:"), e.g. to share one Redis between stacks.
 *
 * Kept on globalThis: route handlers and instrumentation are separate bundles in one process.
 */

const g = globalThis as typeof globalThis & { __diocomKV?: KV; __diocomInstanceId?: string };

export class KvConfigError extends Error {}

/** Throws KvConfigError if REQUIRE_REDIS=true and REDIS_URL is unset; warns for single-instance production. */
export function checkKvConfig(log = true): void {
    const hasRedis = !!process.env.REDIS_URL;
    if (!hasRedis && process.env.REQUIRE_REDIS === 'true') {
        throw new KvConfigError('REQUIRE_REDIS=true but REDIS_URL is not set: refusing to start with per-process state.');
    }
    if (!hasRedis && process.env.NODE_ENV === 'production' && log) {
        kvLog.warn(
            '\n' +
            '*****************************************************************************************\n' +
            '* [kv] REDIS_URL is not set: rate limits, login tokens, swarm signaling, upload progress *\n' +
            '* and job locks are kept IN THIS PROCESS. This app MUST run as a SINGLE instance.        *\n' +
            '* Set REDIS_URL to scale out (REQUIRE_REDIS=true makes a missing REDIS_URL fatal).       *\n' +
            '*****************************************************************************************\n',
        );
    }
}

export function getKV(): KV {
    if (g.__diocomKV) return g.__diocomKV;
    checkKvConfig();
    const url = process.env.REDIS_URL;
    g.__diocomKV = url
        ? new RedisKV(url, { prefix: process.env.KV_PREFIX ?? 'diocom:' })
        : new MemoryKV();
    if (url) kvLog.info({ backend: 'redis', url: redactUrl(url) }, 'shared state backend: redis');
    return g.__diocomKV;
}

/** Test hook: replace (or clear) the singleton. */
export function setKVForTesting(kv: KV | undefined) {
    g.__diocomKV = kv;
}

function redactUrl(url: string): string {
    try {
        const u = new URL(url);
        if (u.password) u.password = '***';
        return u.toString();
    } catch {
        return 'redis://…';
    }
}

/** Random id of this process (used to tag published messages and per-instance status). */
export function instanceId(): string {
    return g.__diocomInstanceId ?? (g.__diocomInstanceId = `${process.pid}-${randomBytes(4).toString('hex')}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Distributed lock (SET NX PX + compare-and-delete). Advisory leases: the holder must finish (or extend) before the
// TTL elapses; use withLock(), which renews automatically and reports a lost lease via `signal`.
// ---------------------------------------------------------------------------------------------------------------

export interface Lock {
    readonly name: string;
    readonly token: string;
    extend(ttlMs: number): Promise<boolean>;
    release(): Promise<boolean>;
}

export async function acquireLock(name: string, ttlMs: number, kv: KV = getKV()): Promise<Lock | null> {
    const key = `lock:${name}`;
    const token = `${instanceId()}:${randomBytes(12).toString('base64url')}`;
    if (!(await kv.setNX(key, token, ttlMs))) return null;
    return {
        name,
        token,
        extend: (ms) => kv.pexpireIfEquals(key, token, ms),
        release: () => kv.delIfEquals(key, token),
    };
}

/** Current holder token of a lock, or null (diagnostics/tests). */
export function lockHolder(name: string, kv: KV = getKV()): Promise<string | null> {
    return kv.get(`lock:${name}`);
}

/**
 * Runs fn only if the lock is free. The lease is renewed every ttlMs/3; if renewal fails (lease lost), `signal`
 * is aborted so fn can stop early. Returns { acquired: false } without running fn when another holder has it.
 */
export async function withLock<T>(
    name: string,
    ttlMs: number,
    fn: (signal: AbortSignal) => Promise<T>,
    kv: KV = getKV(),
): Promise<{ acquired: true; result: T } | { acquired: false }> {
    const lock = await acquireLock(name, ttlMs, kv);
    if (!lock) return { acquired: false };
    const ac = new AbortController();
    const renew = setInterval(() => {
        lock.extend(ttlMs).then(
            (ok) => { if (!ok) ac.abort(new Error(`lock ${name} lost`)); },
            () => ac.abort(new Error(`lock ${name} renewal failed`)),
        );
    }, Math.max(100, Math.floor(ttlMs / 3)));
    (renew as { unref?: () => void }).unref?.();
    try {
        return { acquired: true, result: await fn(ac.signal) };
    } finally {
        clearInterval(renew);
        await lock.release().catch(() => false);
    }
}
