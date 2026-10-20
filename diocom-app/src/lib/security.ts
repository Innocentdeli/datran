import { createHmac, randomBytes, timingSafeEqual, pbkdf2, scrypt, createHash } from 'crypto';
import { promisify } from 'util';
import { createModuleLogger } from './observability/logger';

const log = createModuleLogger('security');

const pbkdf2Async = promisify(pbkdf2);
const scryptAsync = promisify(scrypt) as (pw: string, salt: string | Buffer, keylen: number) => Promise<Buffer>;

// Kept on globalThis so every route bundle in the same process shares one dev secret
const secretHolder = globalThis as unknown as { __diocomDevSecret?: string };

/**
 * Returns the application secret used for HMAC signing / NextAuth.
 * Production: DIOCOM_SECRET or NEXTAUTH_SECRET must be set.
 * Development: falls back to a random per-process secret (sessions/signatures do not survive restarts).
 */
export function getAppSecret(): string {
    const secret = process.env.DIOCOM_SECRET || process.env.NEXTAUTH_SECRET;
    if (secret) return secret;
    // `next build` evaluates route modules (authOptions reads the secret at import) while collecting page data.
    // Nothing is signed or verified during the build, and the server it produces is a separate process that
    // still requires a real secret below, so builds don't need secrets in their environment.
    if (process.env.NEXT_PHASE === 'phase-production-build') {
        return 'build-phase-placeholder-not-used-at-runtime';
    }
    if (process.env.NODE_ENV === 'production') {
        throw new Error('DIOCOM_SECRET or NEXTAUTH_SECRET must be set in production');
    }
    if (!secretHolder.__diocomDevSecret) {
        secretHolder.__diocomDevSecret = randomBytes(32).toString('base64url');
        log.warn('No DIOCOM_SECRET/NEXTAUTH_SECRET set; using a random per-process dev secret.');
    }
    return secretHolder.__diocomDevSecret;
}

export function hmacSign(value: string): string {
    return createHmac('sha256', getAppSecret()).update(value).digest('base64url');
}

export function hmacVerify(value: string, sig: string): boolean {
    if (typeof sig !== 'string' || !sig) return false;
    return safeEqual(hmacSign(value), sig);
}

/** Constant-time string comparison that is safe for differing lengths. */
export function safeEqual(a: string, b: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    // Hash both to fixed length so timingSafeEqual never throws and length isn't leaked via early exit
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function randomToken(bytes = 16): string {
    return randomBytes(bytes).toString('base64url');
}

/**
 * Client IP for rate limiting. Proxy headers are only trusted when TRUST_PROXY === 'true'.
 */
export function getClientIp(req: Request): string {
    if (process.env.TRUST_PROXY === 'true') {
        const xff = req.headers.get('x-forwarded-for');
        if (xff) {
            const first = xff.split(',')[0]?.trim();
            if (first) return first;
        }
        const real = req.headers.get('x-real-ip');
        if (real) return real.trim();
    }
    return 'unknown';
}

const PBKDF2_ITERATIONS = 600000;
const PBKDF2_KEYLEN = 32;
const PBKDF2_DIGEST = 'sha256';

/** Hash a password. Format: pbkdf2$<iterations>$<saltB64url>$<hashB64url> */
export async function hashPassword(pw: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await pbkdf2Async(pw, salt, PBKDF2_ITERATIONS, PBKDF2_KEYLEN, PBKDF2_DIGEST);
    return `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

/** True if the stored hash is in a legacy (weaker) format and should be re-hashed. */
export function needsRehash(stored: string): boolean {
    return typeof stored === 'string' && !stored.startsWith(`pbkdf2$${PBKDF2_ITERATIONS}$`);
}

function bufEqual(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

/**
 * Verify a password against a stored hash. Supports:
 *  - new:    pbkdf2$<iter>$<salt>$<hash>   (sha256, base64url)
 *  - legacy: <saltHex>:<hashHex> using pbkdf2(sha512, 1000 iters, 64 bytes)  [user accounts]
 *  - legacy: <saltHex>:<hashHex> using scrypt(64 bytes)                       [file share passwords]
 * Legacy "salt:hash" is ambiguous between the two, so both are checked.
 */
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
    if (typeof pw !== 'string' || typeof stored !== 'string' || !stored) return false;
    try {
        if (stored.startsWith('pbkdf2$')) {
            const [, iterStr, saltB64, hashB64] = stored.split('$');
            const iterations = parseInt(iterStr, 10);
            if (!Number.isFinite(iterations) || iterations < 1 || !saltB64 || !hashB64) return false;
            const expected = Buffer.from(hashB64, 'base64url');
            const actual = await pbkdf2Async(pw, Buffer.from(saltB64, 'base64url'), iterations, expected.length, PBKDF2_DIGEST);
            return bufEqual(actual, expected);
        }
        const idx = stored.indexOf(':');
        if (idx <= 0) return false;
        const salt = stored.slice(0, idx);
        const expected = Buffer.from(stored.slice(idx + 1), 'hex');
        if (expected.length !== 64) return false;
        // Legacy salts were used as hex *strings* (not decoded), so pass as-is
        const [pb, sc] = await Promise.all([
            pbkdf2Async(pw, salt, 1000, 64, 'sha512'),
            scryptAsync(pw, salt, 64),
        ]);
        const okPb = bufEqual(pb, expected);
        const okSc = bufEqual(sc, expected);
        return okPb || okSc;
    } catch {
        return false;
    }
}
