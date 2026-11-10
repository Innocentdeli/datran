'use client';

import { useState } from 'react';
import Button from '@/components/ui/Button';
import { Mail, Send, CheckCircle2, X, Loader2, AlertCircle, ShieldCheck } from 'lucide-react';

interface EmailTransferModalProps {
  fileId: string;
  fileName: string;
  isOpen: boolean;
  onClose: () => void;
  keyFragment?: string;
}

export default function EmailTransferModal({
  fileId,
  fileName,
  isOpen,
  onClose,
  keyFragment,
}: EmailTransferModalProps) {
  const [recipientInput, setRecipientInput] = useState('');
  const [senderName, setSenderName] = useState('');
  const [senderEmail, setSenderEmail] = useState('');
  const [customMessage, setCustomMessage] = useState('');
  const [requireOtp, setRequireOtp] = useState(false);

  const [loading, setLoading] = useState(false);
  const [successCount, setSuccessCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const recipients = recipientInput
      .split(/[,\n]/)
      .map(r => r.trim())
      .filter(r => r.includes('@'));

    if (!recipients.length) {
      setError('Please enter at least one valid recipient email address.');
      return;
    }

    setLoading(true);

    try {
      const res = await fetch('/api/transfers/send-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fileId,
          recipients,
          senderName: senderName || undefined,
          senderEmail: senderEmail || undefined,
          customMessage: customMessage || undefined,
          requireOtp,
          keyFragment,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to dispatch email transfer');

      setSuccessCount(data.sentCount || recipients.length);
    } catch (err) {
      setError((err as Error)?.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="panel max-w-lg w-full p-6 sm:p-8 space-y-6 relative border border-white/15 animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between pb-3 border-b border-white/10">
          <div className="flex items-center gap-2 text-white font-bold text-lg">
            <Mail className="w-5 h-5 text-primary" />
            Send Transfer via Email
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {successCount !== null ? (
          <div className="text-center py-6 space-y-4">
            <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
              <CheckCircle2 className="w-7 h-7" />
            </div>
            <div className="space-y-1">
              <h3 className="text-lg font-bold text-white">Transfer Dispatched!</h3>
              <p className="text-xs text-gray-300">
                Email notifications with tracked access links sent to {successCount} recipient{successCount === 1 ? '' : 's'}.
              </p>
            </div>
            <p className="text-xs text-gray-400">
              You will receive an email alert the moment any recipient opens or downloads this file.
            </p>
            <Button variant="primary" onClick={onClose} className="w-full">
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label htmlFor="recipients-emails" className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                Recipient Emails * (Comma separated)
              </label>
              <textarea
                id="recipients-emails"
                required
                rows={2}
                placeholder="client@company.com, partner@firm.com"
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 resize-none font-mono text-xs"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="sender-name" className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                  Your Name (Optional)
                </label>
                <input
                  id="sender-name"
                  type="text"
                  placeholder="Jane Doe"
                  value={senderName}
                  onChange={(e) => setSenderName(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500"
                />
              </div>

              <div>
                <label htmlFor="sender-email" className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                  Your Email (For Alerts)
                </label>
                <input
                  id="sender-email"
                  type="email"
                  placeholder="jane@company.com"
                  value={senderEmail}
                  onChange={(e) => setSenderEmail(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500"
                />
              </div>
            </div>

            <div>
              <label htmlFor="custom-message" className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                Custom Message (Optional)
              </label>
              <textarea
                id="custom-message"
                rows={2}
                placeholder="e.g. Please find the finalized agreement attached for your signature."
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 resize-none"
              />
            </div>

            {/* OTP Security Checkbox */}
            <label className="flex items-start gap-3 p-3 rounded-xl bg-white/5 border border-white/10 cursor-pointer hover:border-primary/40 transition-colors">
              <input
                type="checkbox"
                checked={requireOtp}
                onChange={(e) => setRequireOtp(e.target.checked)}
                className="mt-0.5 rounded border-white/20 text-primary focus:ring-0"
              />
              <div className="text-xs">
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                  Require 6-Digit Email Code (OTP Verification)
                </span>
                <p className="text-gray-400 mt-0.5">
                  Recipients must verify their email with a one-time passcode before they can decrypt or download this file.
                </p>
              </div>
            </label>

            {error && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-200">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
              <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={loading || !recipientInput.trim()}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <Send className="w-4 h-4 mr-1.5" />}
                Send Transfer
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
