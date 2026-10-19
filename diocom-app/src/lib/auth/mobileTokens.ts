import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import db from '@/db';
import { withTransaction } from '@/db/tx';
import { getAppSecret } from '@/lib/security';
import { createModuleLogger } from '../observability/logger';

const log = createModuleLogger('mobile-auth');

/**
 * Bearer tokens for the native app (the NextAuth cookie session is web-only):
 *  - access token: HS256 JWT, aud "mobile", iss "diocom", 15 minutes, signed with a key derived from the app secret
 *    (DIOCOM_SECRET / NEXTAUTH_SECRET) so it is unusable as a NextAuth session token and vice versa;
 *  - refresh token: 32 random bytes (base64url), stored only as SHA-256, 30 days, single use. Each refresh rotates it
 *    within the same family; presenting an already rotated (or revoked) token revokes the WHOLE family, so a stolen
 *    refresh token stops working for both the thief and the victim as soon as either uses an old one.
 */

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000;
const ISSUER = 'diocom';
export const MOBILE_AUDIENCE = 'mobile';

function signingKey(): Uint8Array {
    return new Uint8Array(createHmac('sha256', getAppSecret()).update('diocom/mobile-access-token/v1').digest());
}

export function hashRefreshToken(token: string): string {
    return createHash('sha256').update(token).digest('base64url');
}

export interface AccessClaims {
    userId: string;
    role: string;
}

export async function signAccessToken(user: { id: string; role?: string | null }, now = Date.now()): Promise<{ token: string; expiresIn: number }> {
    const iat = Math.floor(now / 1000);
    const token = await new SignJWT({ role: user.role || 'user' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(user.id)
        .setIssuer(ISSUER)
        .setAudience(MOBILE_AUDIENCE)
        .setIssuedAt(iat)
        .setExpirationTime(iat + ACCESS_TOKEN_TTL_S)
        .setJti(randomUUID())
        .sign(signingKey());
    return { token, expiresIn: ACCESS_TOKEN_TTL_S };
}

/** Verified claims, or null for anything invalid (bad signature, wrong audience/issuer/alg, expired, malformed). */
export async function verifyAccessToken(token: string, now = Date.now()): Promise<AccessClaims | null> {
    if (typeof token !== 'string' || token.length > 4096) return null;
    try {
        const { payload } = await jwtVerify(token, signingKey(), {
            algorithms: ['HS256'],
            issuer: ISSUER,
            audience: MOBILE_AUDIENCE,
            currentDate: new Date(now),
        });
        if (typeof payload.sub !== 'string' || !payload.sub) return null;
        return { userId: payload.sub, role: typeof payload.role === 'string' ? payload.role : 'user' };
    } catch {
        return null;
    }
}

export interface TokenPair {
    accessToken: string;
    accessExpiresIn: number;
    refreshToken: string;
    refreshExpiresIn: number;
    tokenType: 'Bearer';
}

async function insertRefreshToken(
    client: { query: (s: string, p?: unknown[]) => Promise<unknown> },
    userId: string, familyId: string, now: number,
): Promise<{ id: string; token: string }> {
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    await client.query(
        'INSERT INTO refresh_tokens (id, token_hash, user_id, family_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, hashRefreshToken(token), userId, familyId, now, now + REFRESH_TOKEN_TTL_MS],
    );
    return { id, token };
}

async function pairFor(user: { id: string; role?: string | null }, refreshToken: string, now: number): Promise<TokenPair> {
    const access = await signAccessToken(user, now);
    return {
        accessToken: access.token,
        accessExpiresIn: access.expiresIn,
        refreshToken,
        refreshExpiresIn: Math.floor(REFRESH_TOKEN_TTL_MS / 1000),
        tokenType: 'Bearer',
    };
}

/** New sign-in: a fresh refresh-token family. */
export async function issueTokenPair(user: { id: string; role?: string | null }, now = Date.now()): Promise<TokenPair> {
    const { token } = await insertRefreshToken(db, user.id, randomUUID(), now);
    return pairFor(user, token, now);
}

export type RefreshOutcome =
    | { ok: true; pair: TokenPair; userId: string }
    | { ok: false; reason: 'invalid' | 'expired' | 'revoked' | 'reused' };

interface RefreshRow {
    id: string;
    user_id: string;
    family_id: string;
    expires_at: number | string;
    rotated_at: number | string | null;
    revoked_at: number | string | null;
}

async function revokeFamily(familyId: string, now: number): Promise<number> {
    const res = await db.query('UPDATE refresh_tokens SET revoked_at = $1 WHERE family_id = $2 AND revoked_at IS NULL', [now, familyId]);
    return Number(res.rowCount) || 0;
}

/** Rotates a refresh token. Reuse of a rotated/revoked token revokes its family. */
export async function rotateRefreshToken(raw: unknown, now = Date.now()): Promise<RefreshOutcome> {
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 256) return { ok: false, reason: 'invalid' };
    const found = await db.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [hashRefreshToken(raw)]);
    const row = found.rows[0] as RefreshRow | undefined;
    if (!row) return { ok: false, reason: 'invalid' };
    if (row.rotated_at !== null && row.rotated_at !== undefined) {
        const n = await revokeFamily(row.family_id, now);
        log.warn({ userId: row.user_id, family: row.family_id.slice(0, 8), revoked: n }, 'refresh token reuse detected: family revoked');
        return { ok: false, reason: 'reused' };
    }
    if (row.revoked_at !== null && row.revoked_at !== undefined) return { ok: false, reason: 'revoked' };
    if (Number(row.expires_at) <= now) return { ok: false, reason: 'expired' };

    const userRes = await db.query('SELECT * FROM users WHERE id = $1', [row.user_id]);
    const user = userRes.rows[0] as { id: string; role?: string } | undefined;
    if (!user) {
        await revokeFamily(row.family_id, now);
        return { ok: false, reason: 'revoked' };
    }

    const rotated = await withTransaction<{ token: string } | null>(async (client, rollback) => {
        const newId = randomUUID();
        // Compare-and-set: of two concurrent refreshes with the same token, exactly one rotates it.
        const cas = await client.query(
            'UPDATE refresh_tokens SET rotated_at = $1, replaced_by = $2 WHERE id = $3 AND rotated_at IS NULL AND revoked_at IS NULL',
            [now, newId, row.id],
        );
        if (!cas.rowCount) return rollback(null);
        const token = randomBytes(32).toString('base64url');
        await client.query(
            'INSERT INTO refresh_tokens (id, token_hash, user_id, family_id, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [newId, hashRefreshToken(token), row.user_id, row.family_id, now, now + REFRESH_TOKEN_TTL_MS],
        );
        return { token };
    });
    if (!rotated) {
        // Lost the race: the token was used twice at the same time -> treat as reuse.
        await revokeFamily(row.family_id, now);
        log.warn({ userId: row.user_id }, 'concurrent refresh token use: family revoked');
        return { ok: false, reason: 'reused' };
    }
    return { ok: true, pair: await pairFor(user, rotated.token, now), userId: row.user_id };
}

/** Sign-out: revokes the token's whole family. True when a live token was found. */
export async function revokeRefreshToken(raw: unknown, now = Date.now()): Promise<boolean> {
    if (typeof raw !== 'string' || raw.length < 20 || raw.length > 256) return false;
    const found = await db.query('SELECT * FROM refresh_tokens WHERE token_hash = $1', [hashRefreshToken(raw)]);
    const row = found.rows[0] as RefreshRow | undefined;
    if (!row) return false;
    return (await revokeFamily(row.family_id, now)) > 0;
}

/** Retention: drops refresh tokens that expired more than a day ago (called by the cleanup job). */
export async function pruneRefreshTokens(now = Date.now()): Promise<number> {
    const res = await db.query('DELETE FROM refresh_tokens WHERE expires_at < $1', [now - 86_400_000]);
    return Number(res.rowCount) || 0;
}
