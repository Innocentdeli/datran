import { NextResponse } from 'next/server';
import { getClientIp } from '@/lib/security';

interface RateLimitEntry {
    count: number;
    resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();
const MAX_STORE_ENTRIES = 50000;

export interface RateLimitConfig {
    maxRequests: number;
    windowMs: number;
}

export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
    retryAfter?: number;
}

function sweep(now: number) {
    for (const [key, entry] of rateLimitStore.entries()) {
        if (now >= entry.resetAt) rateLimitStore.delete(key);
    }
}

export function checkRateLimit(
    identifier: string,
    config: RateLimitConfig
): RateLimitResult {
    const now = Date.now();
    const entry = rateLimitStore.get(identifier);

    // No previous entry or window expired
    if (!entry || now >= entry.resetAt) {
        if (rateLimitStore.size >= MAX_STORE_ENTRIES) sweep(now);
        const resetAt = now + config.windowMs;
        rateLimitStore.set(identifier, { count: 1, resetAt });
        return { allowed: true, remaining: config.maxRequests - 1, resetAt };
    }

    // Within window, check if limit exceeded
    if (entry.count >= config.maxRequests) {
        return {
            allowed: false,
            remaining: 0,
            resetAt: entry.resetAt,
            retryAfter: Math.ceil((entry.resetAt - now) / 1000)
        };
    }

    entry.count++;
    return {
        allowed: true,
        remaining: config.maxRequests - entry.count,
        resetAt: entry.resetAt
    };
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
 * Reusable route helper. Returns a 429 NextResponse when the limit is exceeded,
 * or null when the request may proceed.
 *
 *   const limited = enforceRateLimit(req, 'unlock', { maxRequests: 10, windowMs: 60_000 }, shareId);
 *   if (limited) return limited;
 */
export function enforceRateLimit(
    request: Request,
    scope: string,
    config: RateLimitConfig,
    extraKey?: string
): NextResponse | null {
    const ip = getClientIp(request);
    const keys = [`${scope}:ip:${ip}`];
    if (extraKey) keys.push(`${scope}:key:${extraKey}`);
    for (const key of keys) {
        const result = checkRateLimit(key, config);
        if (!result.allowed) {
            return NextResponse.json(
                { error: 'Too many requests' },
                { status: 429, headers: { 'Retry-After': String(result.retryAfter ?? 60) } }
            );
        }
    }
    return null;
}

/** Non-HTTP variant (e.g. inside NextAuth authorize). Returns true if allowed. */
export function consumeRateLimit(key: string, config: RateLimitConfig): boolean {
    return checkRateLimit(key, config).allowed;
}

// Cleanup old entries periodically
const timer = setInterval(() => sweep(Date.now()), 60000);
if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
