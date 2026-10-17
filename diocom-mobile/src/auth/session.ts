import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

/**
 * Mobile auth session storage.
 *
 * The server currently only has NextAuth cookie sessions, which a native app cannot use cleanly, so nothing
 * writes a token yet and every upload is anonymous. Once the server exposes a token endpoint (see the
 * proposal in the PR notes: POST /api/mobile/token + /api/mobile/token/refresh), a sign-in screen stores the
 * pair with `saveTokens` and the api client attaches `Authorization: Bearer <access>` automatically.
 */
export interface StoredTokens {
    accessToken: string;
    refreshToken: string;
    /** Epoch milliseconds when the access token expires. */
    accessExpiresAt: number;
}

const TOKENS_KEY = 'diocom.auth.tokens.v1';
// SecureStore has no web implementation; the web build stays anonymous rather than keep tokens in localStorage.
const secureStoreAvailable = Platform.OS === 'ios' || Platform.OS === 'android';

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
        return { accessToken: t.accessToken, refreshToken: t.refreshToken, accessExpiresAt: t.accessExpiresAt };
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

/** Current access token, or null when signed out / expired. Refresh will hook in here once the server supports it. */
export async function getAccessToken(): Promise<string | null> {
    const tokens = await loadTokens();
    if (!tokens || tokens.accessExpiresAt <= Date.now()) return null;
    return tokens.accessToken;
}
