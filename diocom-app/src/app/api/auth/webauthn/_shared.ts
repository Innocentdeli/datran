import { createHash } from 'crypto';
import { randomToken } from '@/lib/security';
import { getKV } from '@/lib/kv';

/**
 * Shared WebAuthn configuration and helpers (not a route).
 */

function defaultOrigin(): string {
    const base = process.env.NEXTAUTH_URL || 'http://localhost:3000';
    try {
        return new URL(base).origin;
    } catch {
        return 'http://localhost:3000';
    }
}

export function getWebAuthnConfig() {
    const origin = process.env.WEBAUTHN_ORIGIN || defaultOrigin();
    let rpID = process.env.WEBAUTHN_RP_ID;
    if (!rpID) {
        try {
            rpID = new URL(origin).hostname;
        } catch {
            rpID = 'localhost';
        }
    }
    return { rpID, origin, rpName: process.env.WEBAUTHN_RP_NAME || 'Datran Secure Transfer' };
}

// ---- Challenge storage (shared KV, single-use) ----
// One outstanding challenge per (purpose, user). Stored in the shared KV (Redis when REDIS_URL is set) so the
// options request and the verify request may land on different instances. takeChallenge() is an atomic GETDEL:
// of two concurrent verify attempts at most one sees the challenge (no replay window between read and clear).

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export type ChallengePurpose = 'auth' | 'reg';

const challengeKey = (purpose: ChallengePurpose, userId: string) => `webauthn:chal:${purpose}:${userId}`;

export async function storeChallenge(purpose: ChallengePurpose, userId: string, challenge: string): Promise<void> {
    await getKV().set(challengeKey(purpose, String(userId)), challenge, CHALLENGE_TTL_MS);
}

/** Atomically consumes the outstanding challenge. Returns it if present and unexpired, otherwise null. */
export async function takeChallenge(purpose: ChallengePurpose, userId: string): Promise<string | null> {
    const v = await getKV().getdel(challengeKey(purpose, String(userId)));
    return v || null;
}

// ---- Short-lived, single-use passkey login tokens ----
// Issued only after a successful verifyAuthenticationResponse; consumed by the NextAuth credentials provider,
// possibly on another instance. Stored in the shared KV under SHA-256(token) (the raw bearer token never sits in
// Redis; lookup is by exact hashed key, so there is no secret-dependent string comparison). Consumption is an
// atomic GETDEL: a token can be redeemed exactly once across all instances. TTL enforced by the store.

const LOGIN_TOKEN_TTL_MS = 2 * 60 * 1000;

const tokenKey = (token: string) => `webauthn:login:${createHash('sha256').update(token).digest('base64url')}`;

export async function issuePasskeyLoginToken(userId: string): Promise<string> {
    const token = randomToken(32);
    await getKV().set(tokenKey(token), String(userId), LOGIN_TOKEN_TTL_MS);
    return token;
}

/** Consumes the token (single use, atomic across instances). Returns the bound user id or null. */
export async function consumePasskeyLoginToken(token: unknown): Promise<string | null> {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
    try {
        return (await getKV().getdel(tokenKey(token))) || null;
    } catch (e) {
        console.error('[webauthn] token store unavailable:', e instanceof Error ? e.message : e);
        return null;
    }
}
