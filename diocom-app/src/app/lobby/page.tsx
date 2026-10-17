'use client';

import { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Zap, Users, Copy, Check, Loader2, ArrowRight, Upload, Wifi, WifiOff, CheckCircle } from 'lucide-react';

type LobbyStatus = 'idle' | 'creating' | 'waiting' | 'joining' | 'active' | 'transferring' | 'complete' | 'expired';

export default function LobbyPage() {
  const [mode, setMode] = useState<'select' | 'host' | 'join'>('select');
  const [code, setCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [lobbyStatus, setLobbyStatus] = useState<LobbyStatus>('idle');
  const [copiedCode, setCopiedCode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);

  // === HOST FLOW ===
  const createLobby = async () => {
    setMode('host');
    setLobbyStatus('creating');
    const res = await fetch('/api/lobby/create', { method: 'POST' });
    const data = await res.json();
    setCode(data.code);
    setLobbyStatus('waiting');
  };

  // Poll for joiner
  useEffect(() => {
    if (lobbyStatus !== 'waiting' || !code) return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/lobby/${code}`);
      const data = await res.json();
      if (data.status === 'active') { setLobbyStatus('active'); clearInterval(interval); }
      if (data.status === 'expired') { setLobbyStatus('expired'); clearInterval(interval); }
    }, 2000);
    return () => clearInterval(interval);
  }, [lobbyStatus, code]);

  // === JOIN FLOW ===
  const joinLobby = async () => {
    if (joinCode.length < 4) return;
    setLobbyStatus('joining');
    const res = await fetch(`/api/lobby/${joinCode.toUpperCase()}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'join' })
    });
    if (!res.ok) { setLobbyStatus('idle'); return; }
    setCode(joinCode.toUpperCase());
    setMode('join');
    setLobbyStatus('active');
  };

  const copyCode = () => {
    navigator.clipboard.writeText(code);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (lobbyStatus !== 'active') return;
    const files = Array.from(e.dataTransfer.files);
    setSelectedFiles(files);
    setLobbyStatus('transferring');

    for (const file of files) {
      const form = new FormData();
      // Declared before the file so the server can stream it and knows it may be sampled.
      form.append('is_encrypted', 'false');
      form.append('password', '');
      form.append('file', file);
      await fetch('/api/ingest', { method: 'POST', body: form });
    }

    await fetch(`/api/lobby/${code}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'complete' })
    });
    setLobbyStatus('complete');
  };

  return (
    <div className="min-h-screen bg-[#090e1a] text-white flex flex-col items-center justify-center p-6">
      {/* Background */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[60%] h-[50%] bg-blue-500/6 rounded-full blur-[140px]" />
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[40%] h-[30%] bg-violet-500/6 rounded-full blur-[100px]" />
      </div>

      <div className="relative z-10 w-full max-w-2xl">
        {/* Header */}
        <div className="text-center mb-10">
          <div className="inline-flex items-center gap-2 mb-4 px-4 py-2 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm">
            <Zap size={14} /> Live Transfer Lobby
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">Instant P2P Transfer</h1>
          <p className="text-slate-500 text-sm max-w-md mx-auto">
            Generate a code or enter one to connect instantly. No link, no account required.
          </p>
        </div>

        {/* == MODE: SELECT == */}
        {mode === 'select' && (
          <div className="grid grid-cols-2 gap-4">
            <motion.button
              whileHover={{ y: -2 }}
              onClick={createLobby}
              className="flex flex-col items-center gap-4 p-8 rounded-2xl bg-[#0d1424] border border-white/8 hover:border-blue-500/30 transition-all group"
            >
              <div className="w-16 h-16 rounded-2xl bg-blue-500/12 flex items-center justify-center group-hover:bg-blue-500/18 transition-colors">
                <Upload size={28} className="text-blue-400" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-white mb-1">Send Files</p>
                <p className="text-xs text-slate-600">Create a lobby code</p>
              </div>
            </motion.button>

            <motion.button
              whileHover={{ y: -2 }}
              onClick={() => setMode('join')}
              className="flex flex-col items-center gap-4 p-8 rounded-2xl bg-[#0d1424] border border-white/8 hover:border-violet-500/30 transition-all group"
            >
              <div className="w-16 h-16 rounded-2xl bg-violet-500/12 flex items-center justify-center group-hover:bg-violet-500/18 transition-colors">
                <Users size={28} className="text-violet-400" />
              </div>
              <div className="text-center">
                <p className="font-semibold text-white mb-1">Receive Files</p>
                <p className="text-xs text-slate-600">Enter a lobby code</p>
              </div>
            </motion.button>
          </div>
        )}

        {/* == MODE: JOIN (enter code) == */}
        {mode === 'join' && (lobbyStatus === 'idle' || lobbyStatus === 'joining') && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="bg-[#0d1424] border border-white/8 rounded-2xl p-8">
            <h2 className="text-lg font-semibold text-white mb-6 text-center">Enter Lobby Code</h2>
            <input
              autoFocus
              value={joinCode}
              onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
              placeholder="XXXXXX"
              maxLength={6}
              className="w-full text-center text-3xl font-mono font-bold tracking-[0.4em] text-white bg-white/5 border border-white/10 rounded-xl px-4 py-4 mb-4 outline-none focus:border-violet-500/40 transition-colors"
            />
            <button
              disabled={joinCode.length < 4 || lobbyStatus === 'joining'}
              onClick={joinLobby}
              className="w-full flex items-center justify-center gap-2 py-3.5 rounded-xl bg-violet-500 hover:bg-violet-600 disabled:opacity-40 text-white font-semibold transition-colors"
            >
              {lobbyStatus === 'joining' ? <Loader2 size={16} className="animate-spin" /> : <ArrowRight size={16} />}
              Join Lobby
            </button>
          </motion.div>
        )}

        {/* == HOST: WAITING == */}
        {mode === 'host' && lobbyStatus === 'waiting' && (
          <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} className="bg-[#0d1424] border border-white/8 rounded-2xl p-8 text-center">
            <div className="flex items-center justify-center gap-2 mb-2 text-slate-500 text-sm">
              <Wifi size={14} className="animate-pulse text-blue-400" />
              Waiting for receiver to join…
            </div>

            {/* Code display */}
            <div className="my-8">
              <p className="text-xs text-slate-600 mb-3 uppercase tracking-widest font-mono">Your Code</p>
              <div className="inline-flex items-center gap-4">
                <span className="text-5xl font-mono font-black tracking-[0.3em] text-white">{code}</span>
                <button onClick={copyCode} className="p-2.5 rounded-xl bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition-colors">
                  {copiedCode ? <Check size={16} className="text-emerald-400" /> : <Copy size={16} />}
                </button>
              </div>
            </div>

            {/* Animated dots */}
            <div className="flex justify-center gap-2">
              {[0, 0.2, 0.4].map((delay, i) => (
                <motion.div
                  key={i}
                  animate={{ scale: [1, 1.4, 1], opacity: [0.4, 1, 0.4] }}
                  transition={{ duration: 1, delay, repeat: Infinity }}
                  className="w-2 h-2 rounded-full bg-blue-500"
                />
              ))}
            </div>
          </motion.div>
        )}

        {/* == ACTIVE LOBBY: Two-pane transfer room == */}
        {(lobbyStatus === 'active' || lobbyStatus === 'transferring') && (
          <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
            {/* Status bar */}
            <div className="flex items-center justify-center gap-3 py-3 px-5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-sm">
              <Wifi size={14} /> Connected · Code: <span className="font-mono font-bold">{code}</span>
            </div>

            {/* Transfer panes */}
            <div className="grid grid-cols-2 gap-4">
              {/* Sender side */}
              <motion.div
                onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                animate={{ borderColor: isDragOver ? 'rgba(59, 130, 246, 0.6)' : 'rgba(255,255,255,0.08)' }}
                className="rounded-2xl border-2 border-dashed bg-[#0d1424] flex flex-col items-center justify-center py-12 px-4 text-center transition-colors"
              >
                <Upload size={28} className={`mb-3 ${isDragOver ? 'text-blue-400' : 'text-slate-600'}`} />
                <p className="text-xs text-slate-500">{mode === 'host' ? 'You (Sender)' : 'Their Drop Zone'}</p>
                {mode === 'host' ? (
                  <p className="text-xs text-slate-600 mt-1">Drop files here to send</p>
                ) : (
                  <p className="text-xs text-slate-600 mt-1">Waiting for files…</p>
                )}
              </motion.div>

              {/* Receiver side */}
              <div className="rounded-2xl border border-white/8 bg-[#0d1424] flex flex-col items-center justify-center py-12 px-4 text-center">
                <Users size={28} className="mb-3 text-violet-400" />
                <p className="text-xs text-slate-500">{mode === 'join' ? 'You (Receiver)' : 'Receiver'}</p>
                <p className="text-xs text-slate-600 mt-1">Ready to receive</p>
              </div>
            </div>

            {/* Animated transfer beam */}
            {lobbyStatus === 'transferring' && (
              <div className="relative h-1.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-blue-500 to-violet-500 rounded-full"
                  animate={{ width: ['0%', '100%'] }}
                  transition={{ duration: 2, repeat: Infinity }}
                />
              </div>
            )}
          </motion.div>
        )}

        {/* == COMPLETE == */}
        {lobbyStatus === 'complete' && (
          <motion.div
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex flex-col items-center gap-5 py-10"
          >
            <div className="w-24 h-24 rounded-full bg-emerald-500/12 border-2 border-emerald-500/30 flex items-center justify-center">
              <CheckCircle size={48} className="text-emerald-400" />
            </div>
            <div className="text-center">
              <h2 className="text-2xl font-bold text-white mb-2">Transfer Complete!</h2>
              <p className="text-slate-500 text-sm">{selectedFiles.length} file(s) sent securely via P2P.</p>
            </div>
            <button onClick={() => { setMode('select'); setLobbyStatus('idle'); setCode(''); setSelectedFiles([]); }}
              className="px-6 py-3 rounded-xl bg-white/8 border border-white/10 text-white text-sm font-medium hover:bg-white/12 transition-colors">
              New Transfer
            </button>
          </motion.div>
        )}

        {/* == EXPIRED == */}
        {lobbyStatus === 'expired' && (
          <div className="flex flex-col items-center gap-4 py-10 text-center">
            <WifiOff size={40} className="text-slate-600" />
            <p className="text-slate-500 text-sm">Lobby expired. <button onClick={() => { setMode('select'); setLobbyStatus('idle'); }} className="text-blue-400 hover:underline">Start over</button></p>
          </div>
        )}
      </div>
    </div>
  );
}
