'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Send, Search, X, AtSign, CheckCircle, Loader2 } from 'lucide-react';

interface HandleResult {
  id: string;
  name: string;
  username: string;
  image: string;
}

interface UserPushModalProps {
  shareId: string;
  onClose: () => void;
}

export default function UserPushModal({ shareId, onClose }: UserPushModalProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HandleResult[]>([]);
  const [selected, setSelected] = useState<HandleResult | null>(null);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const searchHandles = useCallback(async (q: string) => {
    if (q.length < 1) { setResults([]); return; }
    const res = await fetch(`/api/inbox/send?q=${encodeURIComponent(q.replace('@', ''))}`);
    if (res.ok) {
      const data = await res.json();
      setResults(data.results || []);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchHandles(query), 300);
    return () => clearTimeout(t);
  }, [query, searchHandles]);

  const handleSend = async () => {
    if (!selected) return;
    setStatus('loading');
    const res = await fetch('/api/inbox/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: selected.username, shareId, message })
    });
    const data = await res.json();
    if (!res.ok) { setStatus('error'); setErrorMsg(data.error); return; }
    setStatus('success');
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 20 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 20 }}
        transition={{ type: 'spring', stiffness: 320, damping: 28 }}
        className="w-full max-w-md bg-[#0d1424] border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/8">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-violet-500/15 rounded-xl">
              <AtSign size={18} className="text-violet-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Push to User</h3>
              <p className="text-[11px] text-slate-500">Send directly to someone&apos;s inbox</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-white/8 text-slate-500 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        {status === 'success' ? (
          <div className="flex flex-col items-center justify-center py-14 px-6 text-center">
            <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 300 }}>
              <CheckCircle size={48} className="text-emerald-400 mb-4" />
            </motion.div>
            <p className="text-white font-semibold text-lg">Sent!</p>
            <p className="text-slate-500 text-sm mt-1">
              File is now in <span className="text-violet-400">@{selected?.username}</span>&apos;s inbox
            </p>
            <button onClick={onClose} className="mt-6 px-6 py-2.5 rounded-xl bg-violet-500/20 border border-violet-500/30 text-violet-300 text-sm hover:bg-violet-500/30 transition-colors">
              Done
            </button>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            {/* Handle Search */}
            {!selected ? (
              <div className="relative">
                <div className="flex items-center gap-2 px-4 py-3 bg-white/5 border border-white/10 rounded-2xl focus-within:border-violet-500/50 transition-colors">
                  <Search size={15} className="text-slate-500 shrink-0" />
                  <span className="text-violet-400 text-sm font-mono shrink-0">@</span>
                  <input
                    autoFocus
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="username"
                    className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 outline-none"
                  />
                </div>

                <AnimatePresence>
                  {results.length > 0 && (
                    <motion.div
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      className="absolute top-full left-0 right-0 mt-2 bg-[#111827] border border-white/10 rounded-xl overflow-hidden z-10 shadow-xl"
                    >
                      {results.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => { setSelected(r); setQuery(''); setResults([]); }}
                          className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/6 transition-colors text-left"
                        >
                          {r.image ? (
                            // OAuth avatar from an arbitrary provider host: next/image would need every host in remotePatterns.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.image} className="w-8 h-8 rounded-full object-cover" alt="" />
                          ) : (
                            <div className="w-8 h-8 rounded-full bg-violet-500/25 flex items-center justify-center text-violet-400 text-xs font-bold">
                              {r.name?.[0]?.toUpperCase()}
                            </div>
                          )}
                          <div>
                            <p className="text-sm text-white font-medium">{r.name}</p>
                            <p className="text-xs text-slate-500">@{r.username}</p>
                          </div>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ) : (
              /* Selected user chip */
              <div className="flex items-center gap-3 px-4 py-3 bg-violet-500/10 border border-violet-500/30 rounded-2xl">
                {selected.image ? (
                  // OAuth avatar from an arbitrary provider host (see above).
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selected.image} className="w-8 h-8 rounded-full" alt="" />
                ) : (
                  <div className="w-8 h-8 rounded-full bg-violet-500/30 flex items-center justify-center text-violet-400 text-xs font-bold">
                    {selected.name?.[0]?.toUpperCase()}
                  </div>
                )}
                <div className="flex-1">
                  <p className="text-sm text-white font-medium">{selected.name}</p>
                  <p className="text-xs text-violet-400">@{selected.username}</p>
                </div>
                <button onClick={() => setSelected(null)} className="text-slate-500 hover:text-white transition-colors">
                  <X size={14} />
                </button>
              </div>
            )}

            {/* Message (optional) */}
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Add a message... (optional)"
              rows={2}
              className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-2xl text-sm text-white placeholder-slate-600 outline-none resize-none focus:border-violet-500/40 transition-colors"
            />

            {status === 'error' && (
              <p className="text-red-400 text-xs px-1">{errorMsg}</p>
            )}

            <button
              disabled={!selected || status === 'loading'}
              onClick={handleSend}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl bg-violet-500 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold transition-colors"
            >
              {status === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
              Send to Inbox
            </button>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
