'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { History, Trash2, ExternalLink, Clock, FileType } from 'lucide-react';
import { getUploadHistory, clearHistory, deleteHistoryItem, UploadHistoryItem } from '@/lib/history';
import { cn, formatFileSize, formatTimestamp } from '@/lib/utils';
import { getFileIcon } from '@/lib/fileUtils';
import Button from '@/components/ui/Button';

export default function UploadHistory() {
    const [isOpen, setIsOpen] = useState(false);
    const [history, setHistory] = useState<UploadHistoryItem[]>([]);

    useEffect(() => {
        setHistory(getUploadHistory());

        // Listen for storage events (updates from other tabs)
        const handleStorage = (e: StorageEvent) => {
            if (e.key === 'diocom_upload_history') {
                setHistory(getUploadHistory());
            }
        };

        window.addEventListener('storage', handleStorage);
        return () => window.removeEventListener('storage', handleStorage);
    }, []);

    // Custom event listener for local updates
    useEffect(() => {
        const handleLocalUpdate = () => setHistory(getUploadHistory());
        window.addEventListener('diocom-history-update', handleLocalUpdate);
        return () => window.removeEventListener('diocom-history-update', handleLocalUpdate);
    }, []);

    const handleDelete = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        const newHistory = deleteHistoryItem(id);
        setHistory(newHistory);
    };

    const handleClear = () => {
        clearHistory();
        setHistory([]);
    };

    if (history.length === 0) return null;

    return (
        <div className="fixed bottom-6 right-6 z-50">
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: 20, scale: 0.9 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 20, scale: 0.9 }}
                        className="absolute bottom-16 right-0 w-80 sm:w-96 glass bg-black/90 border border-white/10 overflow-hidden shadow-2xl rounded-2xl"
                    >
                        <div className="flex items-center justify-between p-4 border-b border-white/10 bg-white/5">
                            <div className="flex items-center gap-2">
                                <History className="w-4 h-4 text-primary" />
                                <h3 className="text-sm font-bold uppercase tracking-wider">Recent Uploads</h3>
                            </div>
                            <button
                                onClick={handleClear}
                                className="text-[10px] text-red-400 hover:text-red-300 uppercase font-bold tracking-widest transition-colors"
                            >
                                Clear All
                            </button>
                        </div>

                        <div className="max-h-[60vh] overflow-y-auto scrollbar-hidden">
                            {history.map((item) => (
                                <div
                                    key={item.id}
                                    onClick={() => window.open(`/v1/${item.shareId}`, '_blank')}
                                    className="p-4 border-b border-white/5 hover:bg-white/5 transition-colors cursor-pointer group relative"
                                >
                                    <div className="flex items-start gap-3">
                                        <div className="w-10 h-10 rounded-lg bg-white/10 flex items-center justify-center text-xl flex-shrink-0">
                                            {getFileIcon(item.type as any)}
                                        </div>

                                        <div className="flex-1 min-w-0">
                                            <h4 className="text-sm font-bold text-white truncate pr-6">{item.filename}</h4>

                                            <div className="flex items-center gap-3 mt-1 text-[10px] text-gray-400 font-mono">
                                                <span className="flex items-center gap-1">
                                                    <FileType className="w-3 h-3" />
                                                    {formatFileSize(item.size)}
                                                </span>
                                                <span className="flex items-center gap-1">
                                                    <Clock className="w-3 h-3" />
                                                    {formatTimestamp(new Date(item.timestamp))}
                                                </span>
                                            </div>

                                            <div className="flex items-center gap-2 mt-2">
                                                {item.stats && (
                                                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 font-bold uppercase">
                                                        {item.stats.ratio}
                                                    </span>
                                                )}
                                            </div>
                                        </div>

                                        <button
                                            onClick={(e) => handleDelete(item.id, e)}
                                            className="absolute top-4 right-4 p-1.5 text-gray-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all rounded-full hover:bg-white/10"
                                        >
                                            <Trash2 className="w-4 h-4" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            <Button
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    "w-12 h-12 rounded-full shadow-lg border border-white/10",
                    isOpen ? "bg-primary text-black" : "bg-black/80 text-white backdrop-blur-xl hover:bg-white/10"
                )}
                style={{ padding: 0 }}
            >
                <History className="w-5 h-5" />
            </Button>
        </div>
    );
}
