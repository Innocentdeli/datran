'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  QrCode,
  Wifi,
  CheckCircle,
  Clock,
  Copy,
  RefreshCw,
  Upload,
  ShieldCheck,
  ArrowRight,
  Download,
  FileText,
  Smartphone,
  Plus,
} from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';

interface CreatedQrSession {
  sessionId: string;
  pairUrl: string;
  expiresAt: number;
}

export default function DesktopPairPage() {
  const [session, setSession] = useState<CreatedQrSession | null>(null);
  const [status, setStatus] = useState<'creating' | 'waiting' | 'paired' | 'complete' | 'expired'>('creating');
  const [fileIds, setFileIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState(300);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [autoDownload, setAutoDownload] = useState(true);
  const [autoDownloadedCount, setAutoDownloadedCount] = useState(0);
  const autoDownloadedRef = useRef<Set<string>>(new Set());
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initSession = async () => {
    setStatus('creating');
    setFileIds([]);
    setAutoDownloadedCount(0);
    autoDownloadedRef.current.clear();
    try {
      const res = await fetch('/api/qr/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileIds: [] }),
      });
      if (!res.ok) throw new Error('Failed to create pairing session');
      const data = await res.json();
      setSession(data);
      setStatus('waiting');
    } catch {
      setStatus('expired');
    }
  };

  useEffect(() => {
    initSession();
  }, []);

  // Poll for connection and incoming files
  useEffect(() => {
    if (!session?.sessionId || status === 'expired') return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/qr/${session.sessionId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.status === 'expired') {
          setStatus('expired');
          clearInterval(interval);
          return;
        }
        if (data.status === 'paired' || data.status === 'complete') {
          setStatus(data.status);
          try {
            const raw = localStorage.getItem('datran_saved_peers');
            const peers = raw ? JSON.parse(raw) : [];
            const updated = [
              { id: `qr-${session.sessionId}`, name: 'Mobile Device (Paired)', type: 'mobile', lastConnected: Date.now() },
              ...peers.filter((p: any) => p.id !== `qr-${session.sessionId}`),
            ].slice(0, 10);
            localStorage.setItem('datran_saved_peers', JSON.stringify(updated));
          } catch {}
        }
        if (Array.isArray(data.fileIds)) {
          setFileIds(data.fileIds);
          // Auto-save incoming files directly to disk / Downloads folder
          if (autoDownload) {
            for (const fId of data.fileIds) {
              if (!autoDownloadedRef.current.has(fId)) {
                autoDownloadedRef.current.add(fId);
                const a = document.createElement('a');
                a.href = `/api/stream?file=${encodeURIComponent(fId)}&download=1`;
                a.download = `paired-${fId.slice(0, 8)}`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setAutoDownloadedCount((c) => c + 1);
              }
            }
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [session?.sessionId, status, autoDownload]);

  // Countdown timer
  useEffect(() => {
    if (!session?.expiresAt) return;
    const interval = setInterval(() => {
      const left = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
      setTimeLeft(left);
      if (left === 0) setStatus('expired');
    }, 1000);
    return () => clearInterval(interval);
  }, [session?.expiresAt]);

  const handleCopyLink = () => {
    if (!session?.pairUrl) return;
    navigator.clipboard.writeText(session.pairUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0 || !session?.sessionId) return;
    setUploading(true);
    setUploadError(null);

    try {
      const newIds: string[] = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const formData = new FormData();
        formData.append('file', file);

        const upRes = await fetch('/api/ingest', {
          method: 'POST',
          body: formData,
        });

        if (!upRes.ok) throw new Error(`Upload failed for ${file.name}`);
        const data = await upRes.json();
        const shareId = data.shareId || data.link?.split('/').pop();
        if (shareId) newIds.push(shareId);
      }

      if (newIds.length > 0) {
        // Attach to session
        const patchRes = await fetch(`/api/qr/${session.sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileIds: newIds }),
        });
        if (!patchRes.ok) throw new Error('Could not attach files to session');
        const patchData = await patchRes.json();
        if (Array.isArray(patchData.fileIds)) {
          setFileIds(patchData.fileIds);
        }
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  return (
    <div className="min-h-screen bg-[#05080E] text-slate-100 flex flex-col items-center justify-center p-4 sm:p-6 relative overflow-hidden">
      {/* Background glow ambiance */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-cyan-500/10 rounded-full blur-[140px]" />
        <div className="absolute bottom-10 right-10 w-[400px] h-[400px] bg-blue-600/10 rounded-full blur-[120px]" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 w-full max-w-lg bg-[#0A0F1D]/90 backdrop-blur-2xl border border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl flex flex-col items-center text-center gap-6"
      >
        {/* Top Header */}
        <div className="flex flex-col items-center gap-2">
          <div className="w-12 h-12 rounded-2xl bg-cyan-500/15 border border-cyan-500/30 flex items-center justify-center text-cyan-400 shadow-lg shadow-cyan-500/20">
            <QrCode size={24} />
          </div>
          <h1 className="text-2xl font-black tracking-tight text-white">Desktop QR Pairing</h1>
          <p className="text-xs text-slate-400 max-w-sm">
            Scan with the Datran mobile app to beam files between your phone and PC over local Wi-Fi.
          </p>
        </div>

        {/* Status: Paired -> Active Console */}
        {status === 'paired' || status === 'complete' ? (
          <div className="w-full flex flex-col items-center gap-5">
            <div className="w-full p-4 rounded-2xl bg-emerald-500/10 border border-emerald-500/25 flex items-center gap-3 text-left">
              <div className="w-10 h-10 rounded-xl bg-emerald-500/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
                <Smartphone size={22} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                  <span className="text-sm font-bold text-white">Phone Connected</span>
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  Direct sync session active. Send or receive files below.
                </p>
              </div>
            </div>

            {/* Auto-save to Local Storage Indicator */}
            <div className="w-full flex items-center justify-between p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-xs text-left">
              <div className="flex items-center gap-2">
                <CheckCircle size={16} className="text-cyan-400 shrink-0" />
                <span className="text-slate-200 font-medium">
                  Auto-save to Downloads: <span className={autoDownload ? 'text-emerald-400 font-bold' : 'text-slate-400'}>{autoDownload ? 'Active' : 'Off'}</span>
                </span>
                {autoDownloadedCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-cyan-500/20 text-cyan-300 font-semibold text-[11px]">
                    {autoDownloadedCount} saved directly to disk
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => setAutoDownload(!autoDownload)}
                className="text-[11px] text-cyan-400 hover:text-cyan-300 underline font-medium cursor-pointer"
              >
                {autoDownload ? 'Turn off' : 'Turn on'}
              </button>
            </div>

            {/* Send to Phone Dropzone */}
            <div className="w-full text-left">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 block mb-2">
                Send Files to Phone
              </label>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileUpload}
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-white/15 hover:border-cyan-400/50 bg-white/[0.02] hover:bg-cyan-500/[0.04] rounded-2xl p-6 flex flex-col items-center justify-center gap-2 cursor-pointer transition"
              >
                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center text-cyan-400">
                  <Upload size={20} />
                </div>
                <span className="text-xs font-medium text-slate-200">
                  {uploading ? 'Uploading to phone...' : 'Click or drop files here to beam to phone'}
                </span>
                <span className="text-[11px] text-slate-500">Photos, videos, PDFs, and documents</span>
              </div>
              {uploadError && <p className="text-xs text-red-400 mt-2">{uploadError}</p>}
            </div>

            {/* Active Transfer Files List */}
            {fileIds.length > 0 ? (
              <div className="w-full text-left">
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Transferred Files ({fileIds.length})
                  </label>
                </div>
                <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                  {fileIds.map((id, index) => (
                    <div
                      key={id}
                      className="p-3 bg-white/5 border border-white/10 rounded-xl flex items-center justify-between gap-3 text-xs"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <FileText size={18} className="text-cyan-400 shrink-0" />
                        <span className="font-mono text-slate-300 truncate">File #{index + 1} ({id.slice(0, 10)}...)</span>
                      </div>
                      <a
                        href={`/v1/${id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="px-3 py-1.5 rounded-lg bg-cyan-500 text-slate-950 font-semibold text-xs hover:bg-cyan-400 transition flex items-center gap-1 shrink-0"
                      >
                        <Download size={13} /> Download
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-3 bg-white/[0.02] border border-white/5 rounded-xl text-xs text-slate-400 w-full">
                No files transferred yet. Drop files above, or select files on your phone to beam them here.
              </div>
            )}

            <button
              onClick={initSession}
              className="mt-2 text-xs text-slate-400 hover:text-slate-200 flex items-center gap-1.5 transition"
            >
              <RefreshCw size={12} /> Disconnect & Start New Session
            </button>
          </div>
        ) : (
          /* Status: Waiting for Scan */
          <>
            {/* QR Code Container */}
            <div className="relative flex flex-col items-center justify-center p-6 bg-white rounded-2xl shadow-xl min-w-[240px] min-h-[240px]">
              <AnimatePresence mode="wait">
                {status === 'creating' ? (
                  <motion.div key="loader" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3">
                    <RefreshCw size={36} className="text-slate-800 animate-spin" />
                    <span className="text-xs text-slate-600 font-semibold">Generating QR session…</span>
                  </motion.div>
                ) : status === 'expired' ? (
                  <motion.div key="expired" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-3 text-slate-700">
                    <Clock size={40} className="text-amber-500" />
                    <span className="text-xs font-bold text-slate-800">QR Session Expired</span>
                    <button
                      onClick={initSession}
                      className="mt-1 px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-semibold hover:bg-slate-800 transition flex items-center gap-1.5"
                    >
                      <RefreshCw size={13} /> Regenerate
                    </button>
                  </motion.div>
                ) : session?.pairUrl ? (
                  <motion.div key="qr" initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
                    <QRCodeCanvas
                      value={session.pairUrl}
                      size={200}
                      level="M"
                      includeMargin={false}
                    />
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            {/* Session details and Copy Bar */}
            {session && status === 'waiting' ? (
              <div className="w-full flex flex-col gap-3">
                <div className="flex items-center justify-between px-3 py-1.5 bg-white/5 rounded-xl border border-white/5 text-[11px] text-slate-400">
                  <span className="flex items-center gap-1 text-cyan-400 font-medium">
                    <Wifi size={13} /> Local LAN Ready
                  </span>
                  <span>Expires in {formatTime(timeLeft)}</span>
                </div>

                <div className="flex items-center gap-2 p-2 bg-[#05080E] border border-white/10 rounded-xl text-xs">
                  <input
                    type="text"
                    readOnly
                    value={session.pairUrl}
                    className="bg-transparent flex-1 text-slate-300 font-mono text-[11px] px-2 outline-none select-all"
                  />
                  <button
                    onClick={handleCopyLink}
                    className="px-3 py-1.5 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-300 rounded-lg text-xs font-semibold transition flex items-center gap-1 border border-cyan-500/30"
                  >
                    <Copy size={13} /> {copied ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        )}

        {/* Footer info */}
        <div className="flex items-center justify-center gap-4 text-[11px] text-slate-500 pt-2 border-t border-white/5 w-full">
          <span className="flex items-center gap-1">
            <ShieldCheck size={14} className="text-emerald-400" /> Zero-Knowledge
          </span>
          <span>•</span>
          <span>Peer-to-Peer</span>
          <span>•</span>
          <span>0 Internet on LAN</span>
        </div>
      </motion.div>
    </div>
  );
}
