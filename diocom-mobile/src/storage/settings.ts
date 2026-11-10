import AsyncStorage from '@react-native-async-storage/async-storage';

/** Non-secret app settings (secrets such as tokens live in SecureStore, see src/auth/session.ts). */
export interface Settings {
    /** Server origin, e.g. "https://datran.app" or "http://localhost:3001". API paths are appended by the api client. */
    serverUrl: string;
    /**
     * Upload without signing in. The server accepts this only while ALLOW_ANONYMOUS_UPLOADS is not "false".
     */
    anonymousUploads: boolean;
    /** Default expiration duration in hours for new upload links (e.g. 24, 72, 168). */
    defaultExpiryHours: number;
    /** Tactile haptic feedback on interactions. */
    hapticsEnabled: boolean;
}

const STORAGE_KEY = 'diocom.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
    serverUrl: process.env.EXPO_PUBLIC_API_URL || 'https://colt-nonembryonic-phraseologically.ngrok-free.dev',
    anonymousUploads: true,
    defaultExpiryHours: 72,
    hapticsEnabled: true,
};

/**
 * Normalises user input to a bare origin + optional base path: trims, drops trailing slashes and a pasted
 * "/api/ingest" suffix. Returns null when it is not an http(s) URL.
 */
export function normalizeServerUrl(input: string): string | null {
    let url = input.trim().replace(/\/+$/, '');
    url = url.replace(/\/api\/ingest$/i, '').replace(/\/+$/, '');
    if (!/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url)) return null;
    return url;
}

function isSettings(value: unknown): value is Partial<Settings> {
    return typeof value === 'object' && value !== null;
}

export async function loadSettings(): Promise<Settings> {
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_SETTINGS;
        const parsed: unknown = JSON.parse(raw);
        if (!isSettings(parsed)) return DEFAULT_SETTINGS;
        const serverUrl = typeof parsed.serverUrl === 'string' ? normalizeServerUrl(parsed.serverUrl) : null;
        return {
            serverUrl: serverUrl ?? DEFAULT_SETTINGS.serverUrl,
            anonymousUploads:
                typeof parsed.anonymousUploads === 'boolean' ? parsed.anonymousUploads : DEFAULT_SETTINGS.anonymousUploads,
            defaultExpiryHours:
                typeof parsed.defaultExpiryHours === 'number' && parsed.defaultExpiryHours > 0
                    ? parsed.defaultExpiryHours
                    : DEFAULT_SETTINGS.defaultExpiryHours,
            hapticsEnabled:
                typeof parsed.hapticsEnabled === 'boolean' ? parsed.hapticsEnabled : DEFAULT_SETTINGS.hapticsEnabled,
        };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export async function saveSettings(settings: Settings): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
