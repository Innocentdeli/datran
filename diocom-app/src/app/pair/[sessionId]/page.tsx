'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { motion } from 'framer-motion';
import { Download, FileText, Wifi, CheckCircle, Loader2, QrCode } from 'lucide-react';

/** Body of GET /api/qr/[sessionId] (fields absent on error responses). */
interface QrSession {
  status?: string;
  fileIds?: string[];
  expiresAt?: number | string;
}

export default function PairPage() {
  const params = useParams();
  const sessionId = params?.sessionId as string;
  const [session, setSession] = useState<QrSession | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'expired' | 'downloading'>('loading');

  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/qr/${sessionId}`)
      .then(r => r.json())
      .then(data => {
        if (data.status === 'expired') { setStatus('expired'); return; }
        setSession(data);
        setStatus('ready');
        // Mark as paired
        fetch(`/api/qr/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'paired' })
        });
      });
  }, [sessionId]);

  const handleDownload = async () => {
    setStatus('downloading');
    // Navigate to first file
    if (session?.fileIds?.[0]) {
      const link = document.createElement('a');
      link.href = `/v1/${session.fileIds[0]}`;
      link.click();
    }
    // Mark complete
    await fetch(`/api/qr/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'complete' })
    });
  };

  return (
    <div className="min-h-screen bg-[#0A0F1A] flex items-center justify-center p-6">
      {/* Background glow */}
      <div className="fixed inset-0 z-0">
        <div className="absolute top-[-20%] left-[-10%] w-[60%] h-[60%] bg-blue-500/8 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-violet-500/8 rounded-full blur-[100px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 w-full max-w-sm bg-[#0d1424]/80 backdrop-blur-xl border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
      >
        {/* Logo bar */}
        <div className="flex items-center gap-2 px-6 py-4 border-b border-white/8">
          <QrCode size={16} className="text-blue-400" />
          <span className="text-sm font-bold text-white tracking-wide">Datran</span>
          <span className="ml-auto text-[10px] text-slate-600 font-mono uppercase tracking-widest">QR Pair</span>
        </div>

        <div className="p-8 flex flex-col items-center text-center gap-5">
          {status === 'loading' && (
            <>
              <Loader2 size={36} className="text-blue-400 animate-spin" />
              <p className="text-slate-400 text-sm">Loading transfer session…</p>
            </>
          )}
          {status === 'expired' && (
            <>
              <div className="w-20 h-20 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                <FileText size={32} className="text-red-400 opacity-50" />
              </div>
              <h2 className="text-white font-semibold text-lg">Session Expired</h2>
              <p className="text-slate-500 text-sm">Ask the sender to generate a new QR code.</p>
            </>
          )}
          {status === 'ready' && (
            <>
              <div className="w-20 h-20 rounded-full bg-blue-500/15 border border-blue-500/30 flex items-center justify-center">
                <Wifi size={36} className="text-blue-400" />
              </div>
              <div>
                <h2 className="text-white font-bold text-xl mb-1">Ready to Receive</h2>
                <p className="text-slate-500 text-sm">
                  {session?.fileIds?.length || 0} file(s) ready for transfer.<br />
                  Encrypted end-to-end. Zero-Knowledge.
                </p>
              </div>
              <button
                onClick={handleDownload}
                className="w-full flex items-center justify-center gap-2 py-4 rounded-2xl bg-blue-500 hover:bg-blue-600 text-white font-semibold text-sm transition-colors shadow-lg shadow-blue-500/20"
              >
                <Download size={18} />
                Accept & Download
              </button>
            </>
          )}
          {status === 'downloading' && (
            <>
              <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring' }}>
                <CheckCircle size={56} className="text-emerald-400" />
              </motion.div>
              <h2 className="text-white font-semibold text-lg">Transfer Complete!</h2>
              <p className="text-slate-500 text-sm">Your file is downloading now.</p>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}
