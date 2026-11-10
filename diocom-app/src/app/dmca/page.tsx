'use client';

import { useState } from 'react';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import { ShieldCheck, Scale, CheckCircle, AlertTriangle, Send } from 'lucide-react';

export default function DmcaPage() {
  const [ownerName, setOwnerName] = useState('');
  const [agentName, setAgentName] = useState('');
  const [email, setEmail] = useState('');
  const [workUrl, setWorkUrl] = useState('');
  const [infringingLinks, setInfringingLinks] = useState('');
  const [signature, setSignature] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agreed) {
      setError('You must confirm the good-faith statement under penalty of perjury.');
      return;
    }

    setSubmitting(true);
    setError(null);

    // Extract first shareId or raw link
    const firstLink = infringingLinks.trim().split('\n')[0].trim();
    const shareId = firstLink.split('/').pop() || firstLink;

    try {
      const details = `DMCA Takedown Notice:\nOwner: ${ownerName}\nAgent: ${agentName}\nWork Source: ${workUrl}\nAll Links: ${infringingLinks}\nSignature: ${signature}`;

      const res = await fetch('/api/abuse/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shareId,
          reason: 'dmca',
          details,
          reporterEmail: email,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit notice');

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-mesh min-h-dvh flex flex-col justify-between p-4 sm:p-8">
      <Header />
      <main className="mx-auto max-w-3xl w-full flex-1 my-8">
        <div className="panel p-6 sm:p-10">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-amber-400">
              <Scale className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white tracking-tight">DMCA Copyright Takedown</h1>
              <p className="text-sm text-gray-400">Digital Millennium Copyright Act Notice Policy &amp; Form</p>
            </div>
          </div>

          <div className="prose prose-invert text-xs text-gray-300 space-y-3 mb-8">
            <p>
              Datran respects the intellectual property rights of creators and copyright owners. In accordance with the Digital Millennium Copyright Act (17 U.S.C. § 512), we will respond expeditiously to notices of alleged copyright infringement submitted using the form below or directed to our designated copyright agent.
            </p>
            <p>
              Please note that filing a fraudulent or bad-faith DMCA takedown notice may result in civil liability for damages, including costs and attorney’s fees under 17 U.S.C. § 512(f).
            </p>
          </div>

          {submitted ? (
            <div className="text-center py-12 border border-emerald-500/20 bg-emerald-500/5 rounded-2xl p-6">
              <CheckCircle className="w-14 h-14 text-emerald-400 mx-auto mb-4" />
              <h2 className="text-lg font-bold text-white">DMCA Notice Received</h2>
              <p className="text-xs text-gray-300 mt-2 max-w-md mx-auto">
                Your copyright infringement claim has been lodged with Datran Legal &amp; Trust Operations. Our agents process notices in accordance with 17 U.S.C. § 512.
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                    Copyright Owner / Entity *
                  </label>
                  <input
                    type="text"
                    required
                    value={ownerName}
                    onChange={(e) => setOwnerName(e.target.value)}
                    placeholder="e.g. Acme Media Corp"
                    className="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                    Authorized Agent Name *
                  </label>
                  <input
                    type="text"
                    required
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    placeholder="Full legal name"
                    className="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Contact Email Address *
                </label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="legal@yourdomain.com"
                  className="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Link / Proof of Original Copyrighted Work *
                </label>
                <input
                  type="url"
                  required
                  value={workUrl}
                  onChange={(e) => setWorkUrl(e.target.value)}
                  placeholder="https://example.com/original-work"
                  className="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Infringing Datran Link(s) to be Removed *
                </label>
                <textarea
                  rows={3}
                  required
                  value={infringingLinks}
                  onChange={(e) => setInfringingLinks(e.target.value)}
                  placeholder="Paste Datran URLs (e.g. https://datran.app/v1/xyz-123)"
                  className="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400 font-mono text-xs resize-none"
                />
              </div>

              <div className="p-4 rounded-xl bg-slate-800/50 border border-white/5 space-y-3">
                <label className="flex items-start gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={agreed}
                    onChange={(e) => setAgreed(e.target.checked)}
                    className="mt-1 rounded border-gray-700 text-cyan-500 focus:ring-0"
                  />
                  <span className="text-xs text-gray-300 leading-relaxed">
                    I state, under penalty of perjury, that I am the copyright owner or authorized to act on behalf of the owner, and that I have a good-faith belief that the disputed use is not authorized by the copyright owner, its agent, or the law.
                  </span>
                </label>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-300 mb-1.5">
                  Electronic Signature (/s/ Full Legal Name) *
                </label>
                <input
                  type="text"
                  required
                  value={signature}
                  onChange={(e) => setSignature(e.target.value)}
                  placeholder="/s/ John Doe"
                  className="w-full bg-slate-800/80 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-cyan-400 font-mono text-xs"
                />
              </div>

              {error && (
                <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 disabled:opacity-50 text-slate-950 font-bold text-sm transition-all shadow-lg shadow-amber-500/20 flex items-center justify-center gap-2"
              >
                {submitting ? (
                  'Submitting DMCA Notice...'
                ) : (
                  <>
                    <Send className="w-4 h-4" />
                    Submit Formal Takedown Notice
                  </>
                )}
              </button>
            </form>
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
