import AsyncStorage from '@react-native-async-storage/async-storage';

export type PeerType = 'desktop' | 'mobile' | 'user' | 'radar' | 'lobby';

export interface SavedPeer {
    /** Unique peer identifier (session ID, user ID, peer ID, or username). */
    id: string;
    /** Human-readable display label (e.g. "Work PC", "iPhone 15", "@alex"). */
    name: string;
    /** Category of peer connection. */
    type: PeerType;
    /** Optional username if this is a registered user account. */
    username?: string;
    /** Associated server URL if applicable. */
    serverUrl?: string;
    /** Timestamp in epoch ms of most recent transfer or connection. */
    lastTransferredAt: number;
    /** Total number of files or sessions beamed with this connection. */
    transferCount: number;
    /** OS / platform metadata. */
    platform?: string;
}

const STORAGE_KEY = 'diocom.saved_peers.v1';
const MAX_SAVED = 30;

function isSavedPeer(value: unknown): value is SavedPeer {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.id === 'string' &&
        typeof v.name === 'string' &&
        typeof v.type === 'string' &&
        typeof v.lastTransferredAt === 'number'
    );
}

/** Loads all saved peer connections, sorted with the most recent first. */
export async function loadSavedPeers(): Promise<SavedPeer[]> {
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isSavedPeer).sort((a, b) => b.lastTransferredAt - a.lastTransferredAt);
    } catch {
        return [];
    }
}

/** Saves or increments a peer's activity whenever a transfer occurs. */
export async function recordPeerTransfer(
    peer: Omit<SavedPeer, 'lastTransferredAt' | 'transferCount'> & { transferCount?: number },
): Promise<SavedPeer[]> {
    try {
        const current = await loadSavedPeers();
        const existingIndex = current.findIndex(
            (p) => p.id === peer.id || (peer.username && p.username === peer.username),
        );
        let next: SavedPeer[];
        const existing = existingIndex >= 0 ? current[existingIndex] : undefined;
        if (existing) {
            const updated: SavedPeer = {
                ...existing,
                ...peer,
                lastTransferredAt: Date.now(),
                transferCount: (existing.transferCount || 1) + 1,
            };
            next = [updated, ...current.filter((_, i) => i !== existingIndex)];
        } else {
            const newPeer: SavedPeer = {
                ...peer,
                lastTransferredAt: Date.now(),
                transferCount: peer.transferCount || 1,
            };
            next = [newPeer, ...current];
        }
        next = next.slice(0, MAX_SAVED);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
    } catch {
        return [];
    }
}

/** Removes a peer from the saved connections list. */
export async function removeSavedPeer(id: string): Promise<SavedPeer[]> {
    try {
        const current = await loadSavedPeers();
        const next = current.filter((p) => p.id !== id);
        await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
    } catch {
        return [];
    }
}
