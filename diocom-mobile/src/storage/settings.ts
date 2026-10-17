import AsyncStorage from '@react-native-async-storage/async-storage';

/** Non-secret app settings (secrets such as tokens live in SecureStore, see src/auth/session.ts). */
export interface Settings {
    /** Server origin, e.g. "http://192.168.1.20:3001". API paths are appended by the api client. */
    serverUrl: string;
    /**
     * Upload without signing in. The server accepts this only while ALLOW_ANONYMOUS_UPLOADS is not "false".
     * Until the server offers a mobile token endpoint this is the only working mode.
     */
    anonymousUploads: boolean;
}

const STORAGE_KEY = 'diocom.settings.v1';

// localhost only works in a simulator/browser on the dev machine; on a device use the machine's LAN address.
export const DEFAULT_SETTINGS: Settings = {
    serverUrl: 'http://localhost:3001',
    anonymousUploads: true,
};

/**
 * Normalises user input to a bare origin + optional base path: trims, drops trailing slashes and a pasted
 * "/api/ingest" suffix (the old app stored the full endpoint). Returns null when it is not an http(s) URL.
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
        };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

export async function saveSettings(settings: Settings): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
