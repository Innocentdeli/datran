import AsyncStorage from '@react-native-async-storage/async-storage';

import type { UploadStats } from '../api/client';

/** One successful upload made from this device. Kept locally until the server exposes a per-user file list. */
export interface HistoryItem {
    id: string;
    filename: string;
    size?: number;
    mimeType?: string;
    link: string;
    serverUrl: string;
    /** Epoch milliseconds. */
    uploadedAt: number;
    stats?: UploadStats;
}

const STORAGE_KEY = 'diocom.history.v1';
const MAX_ITEMS = 200;

function isHistoryItem(value: unknown): value is HistoryItem {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.id === 'string' &&
        typeof v.filename === 'string' &&
        typeof v.link === 'string' &&
        typeof v.uploadedAt === 'number'
    );
}

export async function loadHistory(): Promise<HistoryItem[]> {
    try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(isHistoryItem) : [];
    } catch {
        return [];
    }
}

export async function saveHistory(items: HistoryItem[]): Promise<void> {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_ITEMS)));
}

export function addHistoryItem(items: HistoryItem[], item: HistoryItem): HistoryItem[] {
    return [item, ...items.filter((i) => i.id !== item.id)].slice(0, MAX_ITEMS);
}
