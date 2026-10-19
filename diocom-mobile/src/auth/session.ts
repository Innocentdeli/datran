import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Mobile auth session (bearer tokens from the server's POST /api/mobile/token).
 *
 *  - access token: 15-minute JWT sent as `Authorization: Bearer <token>` by src/api/client.ts;
 *  - refresh token: 30 days, single use. getAccessToken() refreshes shortly before expiry via
 *    POST /api/mobile/token/refresh and stores the rotated pair. A rejected refresh (expired, revoked, or reuse
 *    detected by the server) signs the user out locally.
 *  - signOut() revokes the refresh-token family on the server (POST /api/mobile/token/revoke) and clears storage.
 *
 * Tokens live in SecureStore (Keychain / Keystore). SecureStore has no web implementation, so the web build stays
 * anonymous rather than keep tokens in localStorage.
 */
export interface StoredTokens {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds when the access token expires. */
    accessExpiresAt: number;
    /** Server the tokens belong to (refresh/revoke go there). */
    serverUrl?: string;
}

interface TokenResponse {
    accessToken: string;
    accessExpiresIn: number;
    refreshToken: string;
}

export class AuthError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'AuthError';
    }
}

const TOKENS_KEY = 'diocom.auth.tokens.v1';
/** Refresh this long before the access token expires (clock skew, request latency). */
const REFRESH_MARGIN_MS = 60_000;
export const secureStoreAvailable = Platform.OS === 'ios' || Platform.OS === 'android';

const listeners = new Set<(signedIn: boolean) => void>();
/** Notified when the session starts or ends (sign-in, sign-out, failed refresh). */
export function onSessionChange(fn: (signedIn: boolean) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
const emit = (signedIn: boolean) => listeners.forEach((fn) => fn(signedIn));

const base = (serverUrl: string) => serverUrl.replace(/\/+$/, '');

export async function loadTokens(): Promise<StoredTokens | null> {
    if (!secureStoreAvailable) return null;
    try {
        const raw = await SecureStore.getItemAsync(TOKENS_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return null;
        const t = parsed as Record<string, unknown>;
        if (typeof t.accessToken !== 'string' || typeof t.refreshToken !== 'string' || typeof t.accessExpiresAt !== 'number') {
            return null;
        }
        return {
            accessToken: t.accessToken,
            refreshToken: t.refreshToken,
            accessExpiresAt: t.accessExpiresAt,
            serverUrl: typeof t.serverUrl === 'string' ? t.serverUrl : undefined,
        };
    } catch {
        return null;
    }
}

export async function saveTokens(tokens: StoredTokens): Promise<void> {
    if (!secureStoreAvailable) throw new Error('Secure token storage is not available on this platform');
    await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(tokens));
}

export async function clearTokens(): Promise<void> {
    if (!secureStoreAvailable) return;
    await SecureStore.deleteItemAsync(TOKENS_KEY);
}

function toStored(r: TokenResponse, serverUrl: string): StoredTokens {
    return { accessToken: r.accessToken, refreshToken: r.refreshToken, accessExpiresAt: Date.now() + r.accessExpiresIn * 1000, serverUrl };
}

function isTokenResponse(v: unknown): v is TokenResponse {
    if (typeof v !== 'object' || v === null) return false;
    const r = v as Record<string, unknown>;
    return typeof r.accessToken === 'string' && typeof r.refreshToken === 'string' && typeof r.accessExpiresIn === 'number';
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: unknown }> {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    let data: unknown = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    return { status: res.status, data };
}

/** Email + password sign-in. Stores the token pair; throws AuthError with a message fit for the user. */
export async function signIn(serverUrl: string, email: string, password: string): Promise<void> {
    if (!secureStoreAvailable) throw new AuthError('Sign-in needs secure storage, which is only available in the iOS/Android app.');
    let r: { status: number; data: unknown };
    try {
        r = await postJson(`${base(serverUrl)}/api/mobile/token`, { email: email.trim(), password });
    } catch (err) {
        throw new AuthError(`Could not reach the server: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (r.status === 200 && isTokenResponse(r.data)) {
        await saveTokens(toStored(r.data, serverUrl));
        emit(true);
        return;
    }
    const message = typeof (r.data as { message?: unknown } | null)?.message === 'string' ? (r.data as { message: string }).message : null;
    if (r.status === 429) throw new AuthError(message ?? 'Too many attempts. Please try again later.', 429);
    if (r.status === 401) throw new AuthError(message ?? 'Invalid email or password.', 401);
    if (r.status === 404) throw new AuthError('This server does not support app sign-in yet (update the server).', 404);
    throw new AuthError(message ?? `Sign-in failed (HTTP ${r.status}).`, r.status);
}

let refreshing: Promise<StoredTokens | null> | null = null;

async function refresh(tokens: StoredTokens): Promise<StoredTokens | null> {
    if (!tokens.serverUrl) return null;
    let r: { status: number; data: unknown };
    try {
        r = await postJson(`${base(tokens.serverUrl)}/api/mobile/token/refresh`, { refreshToken: tokens.refreshToken });
    } catch {
        return null; // offline: keep the stored tokens, try again later
    }
    if (r.status === 200 && isTokenResponse(r.data)) {
        const next = toStored(r.data, tokens.serverUrl);
        await saveTokens(next);
        return next;
    }
    if (r.status === 401) {
        // Expired, revoked or reuse detected: the session is over.
        await clearTokens();
        emit(false);
    }
    return null;
}

/** Current access token (refreshed when about to expire), or null when signed out. */
export async function getAccessToken(): Promise<string | null> {
    const tokens = await loadTokens();
    if (!tokens) return null;
    if (tokens.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) return tokens.accessToken;
    // One refresh at a time: concurrent callers share it (a refresh token is single use).
    refreshing ??= refresh(tokens).finally(() => {
        refreshing = null;
    });
    const next = await refreshing;
    return next?.accessToken ?? null;
}

/** True when a session is stored (the access token may need a refresh). */
export async function hasSession(): Promise<boolean> {
    return (await loadTokens()) !== null;
}

/** Revokes the session on the server (best effort) and forgets it locally. */
export async function signOut(): Promise<void> {
    const tokens = await loadTokens();
    if (tokens?.serverUrl) {
        try {
            await postJson(`${base(tokens.serverUrl)}/api/mobile/token/revoke`, { refreshToken: tokens.refreshToken });
        } catch {
            // Offline: the refresh token still expires server-side; local sign-out proceeds.
        }
    }
    await clearTokens();
    emit(false);
}
