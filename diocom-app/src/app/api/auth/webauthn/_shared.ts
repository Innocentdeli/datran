import { randomToken } from '@/lib/security';

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

// ---- Challenge storage (persisted in users.current_challenge with expiry) ----

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function encodeChallenge(challenge: string): string {
    return `${challenge}|${Date.now() + CHALLENGE_TTL_MS}`;
}

/** Returns the challenge if present and unexpired, otherwise null. */
export function decodeChallenge(stored: unknown): string | null {
    if (typeof stored !== 'string' || !stored) return null;
    const sep = stored.lastIndexOf('|');
    if (sep <= 0) return null; // legacy/no-expiry challenges are rejected
    const expires = Number(stored.slice(sep + 1));
    if (!Number.isFinite(expires) || Date.now() > expires) return null;
    return stored.slice(0, sep);
}

// ---- Short-lived, single-use passkey login tokens ----
// Issued only after a successful verifyAuthenticationResponse; consumed by the
// NextAuth credentials provider. In-memory: requires a single server instance
// (or sticky sessions). Move to a shared store for multi-instance deployments.

const LOGIN_TOKEN_TTL_MS = 2 * 60 * 1000;
const MAX_LOGIN_TOKENS = 10000;

type LoginTokenEntry = { userId: string; expiresAt: number };
const globalStore = globalThis as unknown as { __diocomPasskeyTokens?: Map<string, LoginTokenEntry> };
const loginTokens: Map<string, LoginTokenEntry> =
    globalStore.__diocomPasskeyTokens ?? (globalStore.__diocomPasskeyTokens = new Map());

function sweepTokens() {
    const now = Date.now();
    for (const [k, v] of loginTokens) if (v.expiresAt <= now) loginTokens.delete(k);
}

export function issuePasskeyLoginToken(userId: string): string {
    sweepTokens();
    if (loginTokens.size >= MAX_LOGIN_TOKENS) {
        const oldest = loginTokens.keys().next().value;
        if (oldest) loginTokens.delete(oldest);
    }
    const token = randomToken(32);
    loginTokens.set(token, { userId, expiresAt: Date.now() + LOGIN_TOKEN_TTL_MS });
    return token;
}

/** Consumes the token (single use). Returns the bound user id or null. */
export function consumePasskeyLoginToken(token: unknown): string | null {
    if (typeof token !== 'string' || token.length < 16 || token.length > 128) return null;
    const entry = loginTokens.get(token);
    if (!entry) return null;
    loginTokens.delete(token);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.userId;
}
