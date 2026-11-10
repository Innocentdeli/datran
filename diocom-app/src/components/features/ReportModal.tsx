'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Flag, X, ShieldAlert, CheckCircle, AlertTriangle } from 'lucide-react';

interface ReportModalProps {
  shareId: string;
}

export default function ReportModal({ shareId }: ReportModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState<string>('malware');
  const [details, setDetails] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/abuse/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareId,
          reason,
          details,
          reporterEmail: email || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit report');

      setSuccess(true);
      setTimeout(() => {
        setSuccess(false);
        setIsOpen(false);
        setDetails('');
        setEmail('');
      }, 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-red-400 transition-colors"
      >
        <Flag className="w-3.5 h-3.5" />
        Report link or DMCA
      </button>

      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="w-full max-w-md bg-slate-900 border border-white/10 rounded-2xl p-6 shadow-2xl relative"
            >
              <button
                onClick={() => setIsOpen(false)}
                className="absolute top-4 right-4 text-gray-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>

              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400">
                  <ShieldAlert className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">Report Content</h3>
                  <p className="text-xs text-gray-400">Flag violation of acceptable use or copyright</p>
                </div>
              </div>

              {success ? (
                <div className="py-8 text-center">
                  <CheckCircle className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
                  <h4 className="text-white font-bold text-sm">Report Received</h4>
                  <p className="text-xs text-gray-400 mt-1 max-w-xs mx-auto">
                    Thank you. Our Trust & Safety team has received your ticket and will take prompt action.
                  </p>
                </div>
              ) : (
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                      Reason for Report
                    </label>
                    <select
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      className="w-full bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                    >
                      <option value="malware">Malware / Phishing / Virus</option>
                      <option value="dmca">Copyright Infringement (DMCA)</option>
                      <option value="illegal">Illegal or Prohibited Material</option>
                      <option value="harassment">Harassment / Privacy Violation</option>
                      <option value="spam">Spam / Unsolicited</option>
                      <option value="other">Other Violation</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                      Your Email (Optional, required for DMCA notice)
                    </label>
                    <input
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="reporter@example.com"
                      className="w-full bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                      Details / Evidence
                    </label>
                    <textarea
                      rows={3}
                      value={details}
                      onChange={(e) => setDetails(e.target.value)}
                      placeholder="Please provide any relevant details or proof of ownership..."
                      className="w-full bg-slate-800 border border-white/10 rounded-xl px-3 py-2 text-sm text-white focus:outline-none focus:border-red-500 resize-none"
                    />
                  </div>

                  {error && (
                    <div className="p-2.5 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      {error}
                    </div>
                  )}

                  <div className="flex gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => setIsOpen(false)}
                      className="flex-1 py-2 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-gray-300 text-xs font-medium"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={submitting}
                      className="flex-1 py-2 px-3 rounded-xl bg-red-500 hover:bg-red-400 disabled:opacity-50 text-white text-xs font-bold transition-all shadow-lg shadow-red-500/25"
                    >
                      {submitting ? 'Submitting...' : 'Submit Report'}
                    </button>
                  </div>
                </form>
              )}
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
