'use client';

import { useState, useEffect } from 'react';
import { Copy, Check, ExternalLink, QrCode, X, AtSign, Zap } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import QRCodeLib from 'qrcode';
import dynamic from 'next/dynamic';

const UserPushModal = dynamic(() => import('./UserPushModal'), { ssr: false });
const QRSharePanel = dynamic(() => import('./QRSharePanel'), { ssr: false });

export interface ShareLinkPanelProps {
  url: string;
  onClose?: () => void;
}

export default function ShareLinkPanel({ url, onClose }: ShareLinkPanelProps) {
  const [copied, setCopied] = useState(false);
  const [showQR, setShowQR] = useState(false);
  const [qrData, setQrData] = useState<string>('');
  const [showPushModal, setShowPushModal] = useState(false);
  const [showQRPair, setShowQRPair] = useState(false);

  // Extract share ID from URL (strip hash key)
  const shareId = url?.split('/').pop()?.split('#')[0] || '';

  useEffect(() => {
    if (url) {
      QRCodeLib.toDataURL(url, { margin: 1, color: { dark: '#00F2FF', light: '#00000000' } })
        .then(setQrData)
        .catch(console.error);
    }
  }, [url]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-2xl mx-auto"
      >
        <div className="glass p-6 rounded-2xl border border-primary/20 bg-black/40 backdrop-blur-md relative overflow-hidden group">
          <div className="absolute inset-0 bg-primary/5 group-hover:bg-primary/10 transition-colors duration-500" />

          <div className="relative z-10 flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-bold text-primary tracking-[0.2em] uppercase">Transfer Link Ready</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowQR(!showQR)}
                  className="text-gray-400 hover:text-white transition p-2 hover:bg-white/5 rounded-lg border border-transparent hover:border-white/10"
                  title="Toggle QR Code"
                >
                  <QrCode className="w-5 h-5" />
                </button>
                {onClose && (
                  <button
                    onClick={onClose}
                    className="text-gray-400 hover:text-white transition p-2 hover:bg-white/5 rounded-lg border border-transparent hover:border-white/10"
                    title="Close"
                  >
                    <X className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="bg-black/40 rounded-2xl border border-white/5 flex items-center px-6 py-4 relative overflow-hidden">
                <code className="text-gray-200 font-mono text-sm sm:text-base truncate flex-1">{url}</code>
                <div className="absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[#0A0F1A] to-transparent pointer-events-none" />
              </div>

              {/* Primary actions */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  onClick={handleCopy}
                  className={cn(
                    "py-4 rounded-2xl font-bold transition-all duration-300 flex items-center justify-center gap-2",
                    copied
                      ? "bg-success text-white"
                      : "bg-primary text-white hover:bg-primary-dark"
                  )}
                >
                  {copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
                  <span className="text-sm">{copied ? 'Copied' : 'Copy Link'}</span>
                </button>

                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="py-4 rounded-2xl bg-white/5 text-white hover:bg-white/10 border border-white/10 transition-all font-bold flex items-center justify-center gap-2 text-sm"
                >
                  <ExternalLink className="w-5 h-5" />
                  Open
                </a>
              </div>

              {/* Alternative send methods */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setShowPushModal(true)}
                  className="flex items-center justify-center gap-2 py-3 rounded-xl bg-violet-500/12 border border-violet-500/25 text-violet-300 text-xs font-medium hover:bg-violet-500/20 transition-colors"
                >
                  <AtSign size={14} />
                  Push to @user
                </button>
                <button
                  onClick={() => setShowQRPair(true)}
                  className="flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-500/12 border border-blue-500/25 text-blue-300 text-xs font-medium hover:bg-blue-500/20 transition-colors"
                >
                  <Zap size={14} />
                  QR Session
                </button>
              </div>
            </div>

            <AnimatePresence>
              {showQR && qrData && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden flex justify-center pt-4"
                >
                  <div className="bg-white/5 p-4 rounded-xl border border-white/10">
                    <img src={qrData} alt="QR Code" className="w-48 h-48" />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>

      {/* Modals */}
      <AnimatePresence>
        {showPushModal && <UserPushModal shareId={shareId} onClose={() => setShowPushModal(false)} />}
        {showQRPair && <QRSharePanel shareId={shareId} onClose={() => setShowQRPair(false)} />}
      </AnimatePresence>
    </>
  );
}
