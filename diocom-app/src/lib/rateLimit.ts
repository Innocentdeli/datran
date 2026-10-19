import { NextResponse } from 'next/server';
import { getClientIp } from '@/lib/security';
import { getKV } from '@/lib/kv';
import { createModuleLogger } from './observability/logger';
import { recordKvError, recordRateLimitRejection } from './observability/metrics';

const log = createModuleLogger('rateLimit');

/**
 * Sliding-window rate limiting on the shared KV (src/lib/kv): with REDIS_URL the counts are global across all
 * app instances (atomic Lua sliding-window log); without it they are per process (single-instance deployments).
 *
 * Fails CLOSED: if the shared store is unreachable the request is refused (503), so a Redis outage cannot be used
 * to bypass brute-force limits on sign-in / unlock.
 */

export interface RateLimitConfig {
    maxRequests: number;
    windowMs: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
    retryAfter?: number;
    /** True when the store could not be reached (request refused). */
    unavailable?: boolean;
}

export async function checkRateLimit(identifier: string, config: RateLimitConfig): Promise<RateLimitResult> {
    try {
        const r = await getKV().slidingWindow(`rl:${identifier}`, config.maxRequests, config.windowMs);
        if (!r.allowed) recordRateLimitRejection(identifier, 'limited');
        return r.allowed
            ? { allowed: true, remaining: r.remaining, resetAt: r.resetAt }
            : { allowed: false, remaining: 0, resetAt: r.resetAt, retryAfter: Math.max(1, Math.ceil(r.retryAfterMs / 1000)) };
    } catch (e) {
        recordKvError('slidingWindow');
        recordRateLimitRejection(identifier, 'unavailable');
        // Only the scope (first key segment) is logged: the rest of the key can contain a client IP or an email.
        log.error({ err: e, scope: identifier.split(':')[0] }, 'shared store unavailable, refusing request');
        return { allowed: false, remaining: 0, resetAt: Date.now() + 5_000, retryAfter: 5, unavailable: true };
    }
}

/**
 * Client identifier for rate limiting. Proxy headers are only honoured when
 * TRUST_PROXY === 'true' (see getClientIp); otherwise all clients share the
 * 'unknown' bucket, so pair this with a per-resource key where possible.
 */
export function getClientIdentifier(request: Request): string {
    return getClientIp(request);
}

/**
 * Reusable route helper. Returns a 429 (or 503 if the store is down) NextResponse when the request must be
 * refused, or null when it may proceed.
 *
 *   const limited = await enforceRateLimit(req, 'unlock', { maxRequests: 10, windowMs: 60_000 }, shareId);
 *   if (limited) return limited;
 */
export async function enforceRateLimit(
    request: Request,
    scope: string,
    config: RateLimitConfig,
    extraKey?: string
): Promise<NextResponse | null> {
    const ip = getClientIp(request);
    const keys = [`${scope}:ip:${ip}`];
    if (extraKey) keys.push(`${scope}:key:${extraKey}`);
    for (const key of keys) {
        const result = await checkRateLimit(key, config);
        if (!result.allowed) {
            return NextResponse.json(
                { error: result.unavailable ? 'Service temporarily unavailable' : 'Too many requests' },
                { status: result.unavailable ? 503 : 429, headers: { 'Retry-After': String(result.retryAfter ?? 60) } }
            );
        }
    }
    return null;
}

/** Non-HTTP variant (e.g. inside NextAuth authorize). Resolves true if allowed. */
export async function consumeRateLimit(key: string, config: RateLimitConfig): Promise<boolean> {
    return (await checkRateLimit(key, config)).allowed;
}
