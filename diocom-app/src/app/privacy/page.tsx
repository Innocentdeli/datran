import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Link from 'next/link';
import { Lock, ShieldCheck, EyeOff, Server, Database, ArrowRight } from 'lucide-react';

export const metadata = {
  title: 'Privacy Policy | Datran',
  description: 'Learn how Datran enforces zero-knowledge client-side encryption and protects your personal data.',
};

export default function PrivacyPage() {
  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main className="mx-auto w-full max-w-4xl flex-1 py-12">
        <div className="panel p-6 sm:p-12 mb-8 relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
          
          <div className="flex items-center gap-3 mb-4 text-primary">
            <Lock className="w-6 h-6" />
            <span className="text-xs font-mono uppercase tracking-widest text-primary/80">Zero-Knowledge Commitment</span>
          </div>
          
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4 tracking-tight">
            Privacy Policy
          </h1>
          <p className="text-gray-300 text-sm sm:text-base leading-relaxed max-w-2xl">
            Effective Date: October 20, 2026. Datran is engineered on one core premise: your files belong to you. We mathematically enforce zero-knowledge transfer protocols so that neither Datran, nor any ISP, nor any intermediary can access or decrypt your payloads.
          </p>
        </div>

        <div className="panel p-6 sm:p-12 space-y-10 text-gray-300 text-sm sm:text-base leading-relaxed">
          {/* Section 1 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">01.</span>
              Zero-Knowledge Architecture Explained
            </h2>
            <p>
              When you choose end-to-end encryption in Datran, your file is encrypted in memory using standard AES-256-GCM or DCE2 streaming cipher before leaving your local machine. The encryption key is included in the URL fragment hash (e.g. <code className="text-primary bg-primary/10 px-2 py-0.5 rounded font-mono text-xs">#key=...</code>).
            </p>
            <p>
              Under standard web specifications (RFC 3986), URL fragment hashes are <strong className="text-white">never transmitted to the host server in HTTP requests</strong>. Therefore, our servers, databases, and network caches process only opaque, high-entropy ciphertexts indistinguishable from random bytes.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 2 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">02.</span>
              Data We Collect
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium">
                  <ShieldCheck className="w-4 h-4 text-primary" />
                  Account Information
                </div>
                <p className="text-xs text-gray-400">
                  If you create an account: your verified email address, hashed/salted password or WebAuthn public key credential, subscription tier, and creation timestamp.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium">
                  <Database className="w-4 h-4 text-primary" />
                  Transfer Metadata
                </div>
                <p className="text-xs text-gray-400">
                  Payload byte length, expiration timestamps, download counter, and chunk verification hashes. We never record file contents, filenames (for encrypted shares), or directory hierarchies.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium">
                  <EyeOff className="w-4 h-4 text-primary" />
                  Privacy-Friendly Analytics
                </div>
                <p className="text-xs text-gray-400">
                  We use aggregated, cookieless metrics to measure general site traffic and bandwidth health. No personal data, cross-site trackers, or advertising IDs are collected or stored.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium">
                  <Server className="w-4 h-4 text-primary" />
                  Operational Telemetry
                </div>
                <p className="text-xs text-gray-400">
                  Short-lived server logs containing client IP addresses and user-agent strings are preserved for up to 7 days solely for DDoS defense, rate-limiting, and abuse mitigation, after which they are permanently discarded.
                </p>
              </div>
            </div>
          </section>

          <hr className="border-white/10" />

          {/* Section 3 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">03.</span>
              Data Retention & Automatic Expiration
            </h2>
            <p>
              Transfers on Datran are transient by design. When an uploaded transfer reaches its designated expiration window (e.g., 24 hours, 7 days, or upon reaching its download limit), its storage blocks are immediately unlinked and irrevocably purged from our storage nodes during scheduled garbage collection routines.
            </p>
            <p>
              Once purged, neither Datran engineers nor users can restore the files.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 4 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">04.</span>
              Subprocessors & Third Parties
            </h2>
            <p>
              We do not sell, rent, or monetize your personal data. We engage a minimal set of vetted infrastructure subprocessors strictly to operate the platform:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-gray-300">
              <li><strong className="text-white">Stripe Inc.:</strong> Payment processing for Pro, Team, and Enterprise accounts. Card details never touch Datran servers.</li>
              <li><strong className="text-white">Transactional Email (Resend / AWS SES):</strong> Dispatching security notices, password reset links, and verification emails.</li>
              <li><strong className="text-white">Hosting & Edge CDN:</strong> Encrypted chunk delivery and DDoS protection.</li>
            </ul>
          </section>

          <hr className="border-white/10" />

          {/* Section 5 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">05.</span>
              Your Rights (GDPR & CCPA/CPRA)
            </h2>
            <p>
              Regardless of your geographic location, Datran honors fundamental privacy rights:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-gray-300">
              <li><strong className="text-white">Right of Access & Rectification:</strong> You may inspect and update your profile information in your Account Settings.</li>
              <li><strong className="text-white">Right to Erasure (Right to be Forgotten):</strong> You may delete your account and all associated transfers at any time.</li>
              <li><strong className="text-white">Right to Data Portability:</strong> You may export metadata and transfers under your management.</li>
            </ul>
            <p>
              To exercise any of these rights, contact our Data Protection Officer at <a href="mailto:privacy@datran.io" className="text-primary underline">privacy@datran.io</a>.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 6 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">06.</span>
              Security & Vulnerability Disclosures
            </h2>
            <p>
              We adhere to coordinated vulnerability disclosure. If you identify a potential security issue in our cryptography or application boundaries, please consult our <Link href="/security" className="text-primary underline">Security Policy</Link> and contact us following our RFC 9116 guidelines.
            </p>
          </section>
        </div>

        {/* Quick Nav Footer Links */}
        <div className="mt-8 flex flex-wrap gap-4 justify-between items-center text-sm text-gray-400 px-2">
          <Link href="/terms" className="hover:text-white transition-colors flex items-center gap-1">
            Terms of Service <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <Link href="/acceptable-use" className="hover:text-white transition-colors flex items-center gap-1">
            Acceptable Use Policy <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <Link href="/dpa" className="hover:text-white transition-colors flex items-center gap-1">
            Data Processing Agreement (DPA) <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
