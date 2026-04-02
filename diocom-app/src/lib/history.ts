export interface UploadHistoryItem {
    id: string;
    shareId: string;
    filename: string;
    timestamp: number;
    size: number;
    type: string;
    stats?: {
        speed: string;
        ratio: string;
    };
}

const STORAGE_KEY = 'diocom_upload_history';

export function getUploadHistory(): UploadHistoryItem[] {
    if (typeof window === 'undefined') return [];

    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch (e) {
        console.error('Failed to parse upload history:', e);
        return [];
    }
}

export function addToHistory(item: Omit<UploadHistoryItem, 'timestamp'>): UploadHistoryItem[] {
    if (typeof window === 'undefined') return [];

    try {
        const history = getUploadHistory();
        const newItem: UploadHistoryItem = {
            ...item,
            timestamp: Date.now()
        };

        // Add to beginning, limit to 20 items
        const newHistory = [newItem, ...history].slice(0, 20);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
        return newHistory;
    } catch (e) {
        console.error('Failed to save upload history:', e);
        return [];
    }
}

export function clearHistory(): void {
    if (typeof window === 'undefined') return;
    localStorage.removeItem(STORAGE_KEY);
}

export function deleteHistoryItem(id: string): UploadHistoryItem[] {
    if (typeof window === 'undefined') return [];

    const history = getUploadHistory();
    const newHistory = history.filter(item => item.id !== id);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
    return newHistory;
}
