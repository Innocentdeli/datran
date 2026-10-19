'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { History, Trash2, X } from 'lucide-react';
import { getUploadHistory, clearHistory, deleteHistoryItem, UploadHistoryItem } from '@/lib/history';
import { cn, formatFileSize, formatTimestamp } from '@/lib/utils';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import type { FileType } from '@/lib/fileUtils';

const EVENT = 'diocom-history-update';
const STORAGE_KEY = 'diocom_upload_history';
let cache: { raw: string | null; items: UploadHistoryItem[] } = { raw: null, items: [] };

function subscribe(cb: () => void) {
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY) cb(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener(EVENT, cb);
    return () => {
        window.removeEventListener('storage', onStorage);
        window.removeEventListener(EVENT, cb);
    };
}

function snapshot(): UploadHistoryItem[] {
    let raw: string | null = null;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch { /* storage disabled */ }
    if (raw !== cache.raw) cache = { raw, items: getUploadHistory() };
    return cache.items;
}

const EMPTY: UploadHistoryItem[] = [];

/** Floating "Recent uploads" drawer (links this browser created; stored locally only). */
export default function UploadHistory() {
    const history = useSyncExternalStore(subscribe, snapshot, () => EMPTY);
    const [isOpen, setIsOpen] = useState(false);

    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isOpen]);

    const notify = () => window.dispatchEvent(new Event(EVENT));

    if (history.length === 0) return null;

    return (
        <aside aria-label="Recent uploads" className="fixed bottom-4 right-4 z-40 sm:bottom-6 sm:right-6">
            {isOpen && (
                <div
                    id="upload-history-panel"
                    className="absolute bottom-14 right-0 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-white/10 bg-surface shadow-2xl animate-scale-in"
                >
                    <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                        <h2 className="text-sm font-semibold text-white">Recent uploads</h2>
                        <div className="flex items-center gap-1">
                            <button
                                type="button"
                                onClick={() => { clearHistory(); notify(); }}
                                className="rounded-lg px-2 py-1 text-xs font-medium text-red-300 hover:bg-white/5"
                            >
                                Clear all
                            </button>
                            <button
                                type="button"
                                onClick={() => setIsOpen(false)}
                                aria-label="Close recent uploads"
                                className="grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-white/5 hover:text-white"
                            >
                                <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </div>
                    </div>
                    <ul className="max-h-[60vh] divide-y divide-white/5 overflow-y-auto">
                        {history.map((item) => (
                            <li key={item.id} className="group flex items-center gap-3 px-4 py-3 hover:bg-white/[0.03]">
                                <FileTypeIcon type={(item.type as FileType) || 'unknown'} size="sm" />
                                <a href={`/v1/${item.shareId}`} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 rounded">
                                    <span className="block truncate text-sm font-medium text-white">{item.filename}</span>
                                    <span className="block text-xs text-gray-400">
                                        {formatFileSize(item.size)} · {formatTimestamp(new Date(item.timestamp))}
                                    </span>
                                </a>
                                <button
                                    type="button"
                                    onClick={() => { deleteHistoryItem(item.id); notify(); }}
                                    aria-label={`Remove ${item.filename} from history`}
                                    className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-gray-400 hover:bg-white/5 hover:text-red-300"
                                >
                                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                                </button>
                            </li>
                        ))}
                    </ul>
                    <p className="border-t border-white/10 px-4 py-2 text-[11px] text-gray-400">Stored in this browser only, together with each file&apos;s decryption key.</p>
                </div>
            )}

            <button
                type="button"
                onClick={() => setIsOpen((v) => !v)}
                aria-expanded={isOpen}
                aria-controls="upload-history-panel"
                aria-label={`Recent uploads (${history.length})`}
                className={cn(
                    'grid h-12 w-12 place-items-center rounded-full border shadow-lg transition-colors',
                    isOpen ? 'border-primary bg-primary text-on-primary' : 'border-white/10 bg-surface text-white hover:bg-surface-raised'
                )}
            >
                <History className="h-5 w-5" aria-hidden="true" />
            </button>
        </aside>
    );
}
