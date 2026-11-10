'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ShieldCheck, X } from 'lucide-react';
import Button from './Button';

export default function CookieBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const consent = localStorage.getItem('datran_cookie_consent');
      if (!consent) {
        // Small delay so it smoothly animates in
        const timer = setTimeout(() => setVisible(true), 1200);
        return () => clearTimeout(timer);
      }
    } catch {
      // Storage unavailable or blocked
    }
  }, []);

  const handleAcknowledge = () => {
    try {
      localStorage.setItem('datran_cookie_consent', 'essential_only');
    } catch {
      // Ignore storage errors
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <aside
      aria-label="Privacy and cookies notice"
      className="fixed bottom-4 left-4 right-4 z-50 mx-auto max-w-xl animate-in fade-in slide-in-from-bottom-5 duration-300"
    >
      <div className="panel flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 p-4 sm:p-5 shadow-2xl border border-white/15 bg-[#0a0a0f]/95 backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-primary/10 border border-primary/20 text-primary shrink-0 mt-0.5">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="text-xs sm:text-sm text-gray-300 leading-snug">
            <p className="font-medium text-white mb-0.5">Privacy by Design & Essential Cookies</p>
            <p className="text-gray-400">
              Datran never uses third-party trackers or ad cookies. We only store essential session credentials and local cryptographic state.{' '}
              <Link href="/privacy" className="text-primary hover:underline">
                Read Privacy Policy
              </Link>.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 self-end sm:self-center shrink-0">
          <Button
            size="sm"
            variant="primary"
            onClick={handleAcknowledge}
            className="text-xs px-4 py-1.5 h-auto"
          >
            Acknowledge
          </Button>
          <button
            onClick={handleAcknowledge}
            className="p-1 text-gray-400 hover:text-white transition-colors rounded"
            aria-label="Dismiss notice"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
