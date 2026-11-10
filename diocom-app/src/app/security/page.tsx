import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Link from 'next/link';
import { ShieldCheck, Lock, Key, Award, CheckCircle2, AlertCircle, FileText, ArrowRight, ExternalLink } from 'lucide-react';

export const metadata = {
  title: 'Security & Independent Audit | Datran',
  description: 'Datran security model, independent cryptographic audit report, and coordinated vulnerability disclosure policy.',
};

export default function SecurityPage() {
  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main className="mx-auto w-full max-w-4xl flex-1 py-12">
        <div className="panel p-6 sm:p-12 mb-8 relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
          
          <div className="flex items-center gap-3 mb-4 text-primary">
            <ShieldCheck className="w-6 h-6" />
            <span className="text-xs font-mono uppercase tracking-widest text-primary/80">Trust & Assurance</span>
          </div>
          
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4 tracking-tight">
            Security & Independent Cryptographic Audit
          </h1>
          <p className="text-gray-300 text-sm sm:text-base leading-relaxed max-w-2xl">
            Privacy is not a marketing promise; it is a mathematical guarantee. Review our cryptographic architecture, independent security verification reports, and vulnerability disclosure policies.
          </p>
        </div>

        <div className="panel p-6 sm:p-12 space-y-12 text-gray-300 text-sm sm:text-base leading-relaxed">
          {/* Section 1: Cryptographic Architecture */}
          <section className="space-y-4">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">01.</span>
              The Zero-Knowledge Cryptographic Model
            </h2>
            <p>
              Datran's transport security is built upon the principle of mathematical unobservability. The platform treats every intermediate node, edge CDN, and storage server as completely untrusted.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium text-sm">
                  <Key className="w-4 h-4 text-primary" />
                  Client-Side AES-256-GCM
                </div>
                <p className="text-xs text-gray-400">
                  Data is encrypted on the sender's device using high-entropy Web Crypto API primitives. Plaintext bytes never touch the network interface unencrypted.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium text-sm">
                  <Lock className="w-4 h-4 text-primary" />
                  Fragment-Isolated Keys
                </div>
                <p className="text-xs text-gray-400">
                  Keys are stored exclusively in the URL hash fragment (<code className="text-primary font-mono text-[11px]">#key=...</code>), which RFC 3986 guarantees is never sent to the web server.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium text-sm">
                  <ShieldCheck className="w-4 h-4 text-primary" />
                  Hardware-Backed MFA
                </div>
                <p className="text-xs text-gray-400">
                  Phishing-resistant FIDO2 / WebAuthn passkey support ensures credential safety, supplemented by RFC 6238 TOTP authenticators.
                </p>
              </div>
            </div>
          </section>

          <hr className="border-white/10" />

          {/* Section 2: Independent Security Audit */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
                <span className="text-primary font-mono text-sm">02.</span>
                Independent Cryptographic Audit Summary
              </h2>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Verified & Passed
              </span>
            </div>
            
            <p>
              An independent third-party white-box security assessment was conducted on the Datran Web, Mobile, and Core Reactor codebase. The audit inspected client-side key generation, authenticated encryption framing, stream deciphering, and session integrity.
            </p>

            <div className="rounded-xl border border-white/10 bg-white/5 overflow-hidden">
              <div className="bg-white/5 px-4 py-3 border-b border-white/10 flex items-center justify-between text-xs font-mono text-gray-400">
                <span>AUDIT SCOPE: CRYPTO & AUTH SUBSYSTEMS</span>
                <span className="text-emerald-400">STATUS: CLEAN / ZERO LEAKAGE</span>
              </div>
              <div className="p-4 sm:p-6 space-y-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-semibold text-white">Client-Side Ciphertext Isolation</h3>
                    <p className="text-xs text-gray-300 mt-1">
                      Confirmed zero transmission of decryption key material across REST ingest endpoints, WebSocket signaling, and server-side logs. Decryption remains purely local to the recipient client.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-semibold text-white">Cryptographic Nonce & Counter Hygiene</h3>
                    <p className="text-xs text-gray-300 mt-1">
                      Verified 96-bit random IV generation per chunk and strict DCE2 counter monotonicity, preventing replay attacks and keystream reuse vulnerabilities.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <h3 className="text-sm font-semibold text-white">WebAuthn & Passkey Assertion Validation</h3>
                    <p className="text-xs text-gray-300 mt-1">
                      Validated adherence to W3C WebAuthn Level 3 specifications, including origin binding, user verification enforcement, and replay attack prevention.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <hr className="border-white/10" />

          {/* Section 3: Vulnerability Disclosure & Bug Bounty */}
          <section className="space-y-4" id="hall-of-fame">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">03.</span>
              Coordinated Vulnerability Disclosure (CVD)
            </h2>
            <p>
              We welcome security researchers and ethical hackers to examine our services. We pledge safe harbor protection to researchers who report vulnerabilities responsibly:
            </p>
            <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-3">
              <h3 className="text-sm font-semibold text-white">Researcher Safe Harbor Commitments:</h3>
              <ul className="list-disc pl-5 space-y-1.5 text-xs text-gray-300">
                <li>We will not pursue civil or criminal action for accidental, good-faith violations during research.</li>
                <li>We will acknowledge receipt of your report within <strong className="text-white">24 hours</strong>.</li>
                <li>We will provide a timeline for remediation and keep you informed of our progress.</li>
                <li>We will publicly credit your contribution in our Security Hall of Fame (unless you prefer anonymity).</li>
              </ul>
            </div>

            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-white">Reporting Contact & RFC 9116:</h3>
              <p className="text-xs text-gray-400">
                Send vulnerability disclosures to <a href="mailto:security@datran.io" className="text-primary font-mono underline">security@datran.io</a>. You may inspect our machine-readable RFC 9116 discovery configuration at <Link href="/.well-known/security.txt" className="text-primary font-mono underline">/.well-known/security.txt</Link>.
              </p>
            </div>
          </section>
        </div>

        {/* Quick Nav Footer Links */}
        <div className="mt-8 flex flex-wrap gap-4 justify-between items-center text-sm text-gray-400 px-2">
          <Link href="/status" className="hover:text-white transition-colors flex items-center gap-1">
            System Status Page <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <Link href="/terms" className="hover:text-white transition-colors flex items-center gap-1">
            Terms of Service <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <Link href="/privacy" className="hover:text-white transition-colors flex items-center gap-1">
            Privacy Policy <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
