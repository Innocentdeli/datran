'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Inbox, Check, X, FileText, Image, Archive, Bell } from 'lucide-react';

interface InboxItem {
  id: string;
  sender_name: string;
  sender_username: string;
  sender_image: string;
  original_name: string;
  file_size: number;
  mime_type: string;
  share_id: string;
  status: 'pending' | 'accepted' | 'declined';
  message: string | null;
  created_at: number;
}

function fileIcon(mime: string) {
  if (mime?.startsWith('image/')) return <Image size={16} />;
  if (mime?.includes('zip') || mime?.includes('tar')) return <Archive size={16} />;
  return <FileText size={16} />;
}

function formatBytes(bytes: number) {
  if (!bytes) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function InboxPanel() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const fetchInbox = useCallback(async () => {
    const res = await fetch('/api/inbox');
    if (!res.ok) return;
    const data = await res.json();
    setItems(data.items || []);
    setPendingCount(data.pendingCount || 0);
  }, []);

  useEffect(() => {
    fetchInbox();
    const interval = setInterval(fetchInbox, 15000);
    return () => clearInterval(interval);
  }, [fetchInbox]);

  const handleAction = async (id: string, action: 'accept' | 'decline') => {
    setLoading(true);
    const res = await fetch(`/api/inbox/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    if (res.ok) await fetchInbox();
    setLoading(false);
  };

  return (
    <div className="relative">
      {/* Bell trigger */}
      <button
        onClick={() => setOpen(!open)}
        className="relative p-3 rounded-2xl bg-white/5 border border-white/10 hover:bg-white/10 transition-all hover:scale-105"
        aria-label="Open Inbox"
      >
        <Inbox size={20} className="text-slate-300" />
        {pendingCount > 0 && (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-violet-500 text-white text-[10px] font-bold flex items-center justify-center"
          >
            {pendingCount > 9 ? '9+' : pendingCount}
          </motion.span>
        )}
      </button>

      {/* Drawer */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, x: 20, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 300, damping: 28 }}
            className="absolute bottom-14 right-0 w-96 bg-[#0d1424] border border-white/10 rounded-2xl shadow-2xl overflow-hidden z-50"
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/8">
              <div className="flex items-center gap-2">
                <Bell size={16} className="text-violet-400" />
                <span className="text-sm font-semibold text-white">File Inbox</span>
              </div>
              <span className="text-xs text-slate-500">{pendingCount} pending</span>
            </div>

            {/* Items */}
            <div className="max-h-[400px] overflow-y-auto divide-y divide-white/5">
              {items.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-600">
                  <Inbox size={32} className="mb-3 opacity-40" />
                  <p className="text-sm">Your inbox is empty</p>
                </div>
              ) : (
                items.map((item) => (
                  <motion.div
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`px-5 py-4 ${item.status !== 'pending' ? 'opacity-40' : ''}`}
                  >
                    {/* Sender */}
                    <div className="flex items-center gap-2 mb-2">
                      {item.sender_image ? (
                        <img src={item.sender_image} className="w-6 h-6 rounded-full" alt="" />
                      ) : (
                        <div className="w-6 h-6 rounded-full bg-violet-500/30 flex items-center justify-center text-violet-400 text-[10px] font-bold">
                          {item.sender_name?.[0]?.toUpperCase() || '?'}
                        </div>
                      )}
                      <span className="text-xs font-medium text-slate-300">{item.sender_name}</span>
                      {item.sender_username && (
                        <span className="text-[10px] text-slate-600">@{item.sender_username}</span>
                      )}
                    </div>

                    {/* File info */}
                    <div className="flex items-center gap-2 px-3 py-2 bg-white/4 rounded-xl mb-3">
                      <span className="text-slate-400">{fileIcon(item.mime_type)}</span>
                      <span className="text-xs text-white font-mono truncate flex-1">{item.original_name || item.share_id}</span>
                      <span className="text-[10px] text-slate-600 whitespace-nowrap">{formatBytes(item.file_size)}</span>
                    </div>

                    {item.message && (
                      <p className="text-xs text-slate-500 italic mb-3">"{item.message}"</p>
                    )}

                    {/* Actions */}
                    {item.status === 'pending' && (
                      <div className="flex gap-2">
                        <button
                          disabled={loading}
                          onClick={() => handleAction(item.id, 'accept')}
                          className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl bg-violet-500/20 border border-violet-500/40 text-violet-300 text-xs font-medium hover:bg-violet-500/30 transition-colors"
                        >
                          <Check size={12} />
                          Accept
                        </button>
                        <button
                          disabled={loading}
                          onClick={() => handleAction(item.id, 'decline')}
                          className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-white/5 border border-white/10 text-slate-500 text-xs hover:bg-white/10 transition-colors"
                        >
                          <X size={12} />
                          Decline
                        </button>
                        <a
                          href={`/v1/${item.share_id}`}
                          target="_blank"
                          className="sr-only"
                        >
                          Download
                        </a>
                      </div>
                    )}
                    {item.status === 'accepted' && (
                      <a
                        href={`/v1/${item.share_id}`}
                        target="_blank"
                        className="block text-center py-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 text-xs font-medium hover:bg-emerald-500/25 transition-colors"
                      >
                        Download File
                      </a>
                    )}
                    {item.status === 'declined' && (
                      <p className="text-center text-xs text-slate-600">Declined</p>
                    )}
                  </motion.div>
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
