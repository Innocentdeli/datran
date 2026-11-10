'use client';

import { useState } from 'react';
import Button from '@/components/ui/Button';
import { ShieldCheck, Mail, Lock, KeyRound, Loader2, AlertCircle, ArrowLeft } from 'lucide-react';

interface OtpGateProps {
  fileId: string;
  fileName: string;
  onVerified: (token: string) => void;
}

export default function OtpGate({ fileId, fileName, onVerified }: OtpGateProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSendCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/transfers/otp/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, email }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send verification code');

      setStep('code');
    } catch (err) {
      setError((err as Error)?.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch('/api/transfers/otp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileId, email, code }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid code');

      onVerified(data.token);
    } catch (err) {
      setError((err as Error)?.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="panel p-6 sm:p-10 border border-primary/30 max-w-md w-full mx-auto relative overflow-hidden text-center space-y-6">
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-70" />

      <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary mx-auto">
        <Lock className="w-7 h-7" />
      </div>

      <div className="space-y-1">
        <h2 className="text-xl font-bold text-white tracking-tight">Recipient Verification Required</h2>
        <p className="text-xs text-gray-300">
          The sender protected <strong className="text-white">"{fileName}"</strong> with two-factor email verification.
        </p>
      </div>

      {step === 'email' ? (
        <form onSubmit={handleSendCode} className="space-y-4 text-left">
          <div>
            <label htmlFor="otp-email" className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
              Enter Your Email Address
            </label>
            <div className="relative">
              <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                id="otp-email"
                type="email"
                required
                autoComplete="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500"
              />
            </div>
            <p className="text-[11px] text-gray-500 mt-1">Must match the recipient email specified by the sender.</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-200">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={loading || !email.includes('@')}
            className="w-full"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
            Request One-Time Code
          </Button>
        </form>
      ) : (
        <form onSubmit={handleVerifyCode} className="space-y-4 text-left">
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="otp-code" className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Enter 6-Digit Security Code
              </label>
              <button
                type="button"
                onClick={() => setStep('email')}
                className="text-[11px] text-primary hover:underline flex items-center gap-1"
              >
                <ArrowLeft className="w-3 h-3" /> Change email
              </button>
            </div>
            <div className="relative">
              <KeyRound className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                id="otp-code"
                type="text"
                required
                maxLength={6}
                autoFocus
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-center font-mono tracking-widest text-lg font-bold text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-600"
              />
            </div>
            <p className="text-[11px] text-gray-400 mt-1">Sent to <strong className="text-white">{email}</strong>. Check your spam folder if not received.</p>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-200">
              <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            disabled={loading || code.length !== 6}
            className="w-full"
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2" />}
            Verify & Unlock File
          </Button>

          <div className="text-center">
            <button
              type="button"
              onClick={handleSendCode}
              disabled={loading}
              className="text-xs text-gray-400 hover:text-white transition-colors"
            >
              Didn't receive a code? Click to resend
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
