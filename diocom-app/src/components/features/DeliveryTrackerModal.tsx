'use client';

import { useState, useEffect } from 'react';
import { Mail, Send, CheckCircle2, Eye, Download, Clock, ShieldCheck, X, Loader2, Plus, Users } from 'lucide-react';
import Button from '@/components/ui/Button';
import EmailTransferModal from './EmailTransferModal';

interface Recipient {
  id: string;
  file_id: string;
  email: string;
  token: string;
  status: 'sent' | 'opened' | 'downloaded';
  sent_at: number;
  opened_at: number | null;
  downloaded_at: number | null;
  otp_verified_at: number | null;
}

interface DeliveryTrackerModalProps {
  fileId: string;
  fileName: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function DeliveryTrackerModal({
  fileId,
  fileName,
  isOpen,
  onClose,
}: DeliveryTrackerModalProps) {
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showSendModal, setShowSendModal] = useState(false);

  const fetchRecipients = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/transfers/${fileId}/recipients`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch recipients');
      setRecipients(data.recipients || []);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to load tracking data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchRecipients();
    }
  }, [isOpen, fileId]);

  if (!isOpen) return null;

  const total = recipients.length;
  const opened = recipients.filter((r) => r.status === 'opened' || r.status === 'downloaded').length;
  const downloaded = recipients.filter((r) => r.status === 'downloaded').length;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-fade-in">
        <div className="panel w-full max-w-xl border border-white/10 shadow-2xl overflow-hidden flex flex-col max-h-[85vh]">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-white/10 p-5 bg-white/[0.02]">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
                <Users className="w-5 h-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-base font-bold text-white tracking-tight truncate">Delivery &amp; Tracking</h2>
                <p className="text-xs text-gray-400 truncate">{fileName}</p>
              </div>
            </div>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-white/5 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Stats Bar */}
          <div className="grid grid-cols-3 divide-x divide-white/10 border-b border-white/10 bg-black/20 text-center py-3">
            <div>
              <p className="text-[11px] uppercase tracking-wider text-gray-400 font-semibold">Sent</p>
              <p className="text-lg font-bold text-white mt-0.5">{total}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-sky-400 font-semibold">Opened</p>
              <p className="text-lg font-bold text-white mt-0.5">{opened}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wider text-emerald-400 font-semibold">Downloaded</p>
              <p className="text-lg font-bold text-white mt-0.5">{downloaded}</p>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400">
                <Loader2 className="w-6 h-6 animate-spin text-primary mb-2" />
                <p className="text-xs">Loading delivery tracking details...</p>
              </div>
            ) : error ? (
              <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-200">
                {error}
              </div>
            ) : recipients.length === 0 ? (
              <div className="text-center py-10 space-y-3">
                <Mail className="w-10 h-10 text-gray-500 mx-auto" />
                <p className="text-sm font-medium text-white">No email dispatches yet</p>
                <p className="text-xs text-gray-400 max-w-sm mx-auto">
                  You haven&apos;t sent this file directly via email. Send it to clients or colleagues to track open and download receipts.
                </p>
                <Button variant="primary" size="sm" onClick={() => setShowSendModal(true)} className="mt-2">
                  <Send className="w-3.5 h-3.5 mr-1.5" /> Send to Recipients
                </Button>
              </div>
            ) : (
              <ul className="divide-y divide-white/5 border border-white/10 rounded-xl overflow-hidden bg-white/[0.02]">
                {recipients.map((rec) => (
                  <li key={rec.id} className="p-3.5 flex items-center justify-between gap-3 text-xs">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white truncate">{rec.email}</span>
                        {rec.otp_verified_at && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                            <ShieldCheck className="w-2.5 h-2.5" /> OTP Verified
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        Sent {new Date(rec.sent_at).toLocaleString()}
                      </p>
                    </div>

                    <div className="shrink-0 flex items-center gap-2">
                      {rec.status === 'downloaded' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                          <Download className="w-3.5 h-3.5" /> Downloaded
                        </span>
                      ) : rec.status === 'opened' ? (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-sky-500/15 text-sky-300 border border-sky-500/30">
                          <Eye className="w-3.5 h-3.5" /> Opened
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-white/5 text-gray-300 border border-white/10">
                          <Clock className="w-3.5 h-3.5" /> Sent (Unopened)
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Footer */}
          <div className="p-4 border-t border-white/10 bg-white/[0.02] flex items-center justify-between">
            <span className="text-xs text-gray-400">
              Receipts sent instantly to your sender email
            </span>
            <div className="flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowSendModal(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" /> Send to More
              </Button>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        </div>
      </div>

      {showSendModal && (
        <EmailTransferModal
          fileId={fileId}
          fileName={fileName}
          isOpen={showSendModal}
          onClose={() => {
            setShowSendModal(false);
            fetchRecipients();
          }}
        />
      )}
    </>
  );
}
