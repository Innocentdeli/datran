'use client';

import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { QrCode, Wifi, CheckCircle, Clock, RefreshCw, X } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';

interface QRSharePanelProps {
  shareId: string;
  onClose: () => void;
}

type SessionStatus = 'creating' | 'waiting' | 'paired' | 'complete' | 'expired';

interface CreatedQrSession {
  sessionId: string;
  pairUrl: string;
  expiresAt: number;
}

async function requestQrSession(shareId: string): Promise<CreatedQrSession | null> {
  const res = await fetch('/api/qr/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileIds: [shareId] })
  });
  if (!res.ok) return null;
  return res.json();
}

export default function QRSharePanel({ shareId, onClose }: QRSharePanelProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [pairUrl, setPairUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus>('creating');
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [timeLeft, setTimeLeft] = useState(300);

  const applySession = (data: CreatedQrSession | null) => {
    if (!data) return;
    setSessionId(data.sessionId);
    setPairUrl(data.pairUrl);
    setExpiresAt(data.expiresAt);
    setStatus('waiting');
  };

  // Retry button: status starts as 'creating' on mount, so only a regeneration needs to reset it.
  const createSession = () => {
    setStatus('creating');
    requestQrSession(shareId).then(applySession);
  };

  // Poll session state
  useEffect(() => {
    if (!sessionId || status === 'complete' || status === 'expired') return;
    const interval = setInterval(async () => {
      const res = await fetch(`/api/qr/${sessionId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.status === 'expired') { setStatus('expired'); clearInterval(interval); return; }
      setStatus(data.status as SessionStatus);
      if (data.status === 'complete') clearInterval(interval);
    }, 2000);
    return () => clearInterval(interval);
  }, [sessionId, status]);

  // Countdown timer
  useEffect(() => {
    if (!expiresAt) return;
    const interval = setInterval(() => {
      const left = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      setTimeLeft(left);
      if (left === 0) setStatus('expired');
    }, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  useEffect(() => {
    requestQrSession(shareId).then(applySession);
  }, [shareId]);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  const statusConfig = {
    creating: { icon: <RefreshCw size={20} className="animate-spin" />, text: 'Generating QR…', color: 'text-slate-400' },
    waiting: { icon: <QrCode size={20} />, text: 'Waiting for scan…', color: 'text-blue-400' },
    paired: { icon: <Wifi size={20} />, text: 'Device paired! Connecting…', color: 'text-violet-400' },
    complete: { icon: <CheckCircle size={20} />, text: 'Transfer complete!', color: 'text-emerald-400' },
    expired: { icon: <Clock size={20} />, text: 'Session expired', color: 'text-red-400' },
  };

  const cfg = statusConfig[status];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-md flex items-center justify-center p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.9, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.9, opacity: 0, y: 16 }}
        transition={{ type: 'spring', stiffness: 300, damping: 26 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm bg-[#0d1424] border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/8">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-blue-500/15 rounded-xl">
              <QrCode size={18} className="text-blue-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">QR Transfer</h3>
              <p className="text-[11px] text-slate-500">Scan to receive file instantly</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-white/8 text-slate-500 hover:text-white transition-colors">
            <X size={16} />
          </button>
        </div>

        <div className="p-6 flex flex-col items-center gap-5">
          {/* QR Code */}
          <AnimatePresence mode="wait">
            {status === 'complete' ? (
              <motion.div key="done" initial={{ scale: 0 }} animate={{ scale: 1 }} className="flex flex-col items-center gap-3">
                <div className="w-24 h-24 rounded-full bg-emerald-500/15 border-2 border-emerald-500/40 flex items-center justify-center">
                  <CheckCircle size={40} className="text-emerald-400" />
                </div>
                <p className="text-emerald-400 font-semibold">File Received!</p>
              </motion.div>
            ) : status === 'expired' ? (
              <motion.div key="exp" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-4">
                <div className="w-48 h-48 rounded-2xl bg-white/4 flex items-center justify-center text-slate-600">
                  <Clock size={48} />
                </div>
                <button onClick={createSession} className="px-5 py-2.5 rounded-xl bg-blue-500/20 border border-blue-500/30 text-blue-300 text-sm font-medium hover:bg-blue-500/30 transition-colors flex items-center gap-2">
                  <RefreshCw size={14} /> Generate New QR
                </button>
              </motion.div>
            ) : pairUrl ? (
              <motion.div key="qr" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} className="relative">
                <div className={`p-4 rounded-2xl bg-white transition-all ${status === 'paired' ? 'ring-4 ring-violet-500/60' : ''}`}>
                  <QRCodeCanvas
                    value={pairUrl}
                    size={180}
                    level="M"
                    includeMargin={false}
                    bgColor="#FFFFFF"
                    fgColor="#0d1424"
                  />
                </div>
                {status === 'paired' && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="absolute inset-0 rounded-2xl bg-violet-500/20 flex items-center justify-center"
                  >
                    <div className="bg-violet-500/80 text-white text-xs font-bold px-3 py-1.5 rounded-full">
                      Paired ✓
                    </div>
                  </motion.div>
                )}
              </motion.div>
            ) : (
              <div className="w-[212px] h-[212px] rounded-2xl bg-white/4 animate-pulse" />
            )}
          </AnimatePresence>

          {/* Status */}
          <div className={`flex items-center gap-2 text-sm font-medium ${cfg.color}`}>
            {cfg.icon}
            <span>{cfg.text}</span>
          </div>

          {/* Timer */}
          {status === 'waiting' && (
            <div className="flex items-center gap-2 text-xs text-slate-600">
              <Clock size={12} />
              Expires in {formatTime(timeLeft)}
            </div>
          )}

          {/* Instruction */}
          {status === 'waiting' && (
            <p className="text-xs text-slate-600 text-center max-w-[240px] leading-relaxed">
              Open <span className="text-slate-400 font-mono">datran.io</span> on your phone and scan this code. No app required.
            </p>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
