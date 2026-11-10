import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Link from 'next/link';
import { FileCheck, Shield, Download, CheckCircle2, Building2, ArrowRight } from 'lucide-react';

export const metadata = {
  title: 'Data Processing Agreement (DPA) | Datran Business',
  description: 'Standardized Data Processing Addendum for business customers, complying with GDPR Art 28 and CCPA.',
};

export default function DPAPage() {
  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main className="mx-auto w-full max-w-4xl flex-1 py-12">
        <div className="panel p-6 sm:p-12 mb-8 relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
          
          <div className="flex items-center gap-3 mb-4 text-primary">
            <Building2 className="w-6 h-6" />
            <span className="text-xs font-mono uppercase tracking-widest text-primary/80">Enterprise Compliance</span>
          </div>
          
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4 tracking-tight">
            Data Processing Agreement (DPA)
          </h1>
          <p className="text-gray-300 text-sm sm:text-base leading-relaxed max-w-2xl">
            This Data Processing Addendum ("DPA") supplements the Datran Terms of Service and applies to enterprise and business customers whose use of Datran includes processing Personal Data subject to the General Data Protection Regulation (GDPR) or the California Consumer Privacy Act (CCPA/CPRA).
          </p>
        </div>

        <div className="panel p-6 sm:p-12 space-y-10 text-gray-300 text-sm sm:text-base leading-relaxed">
          {/* Section 1 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">01.</span>
              Roles & Scope of Processing
            </h2>
            <p>
              Under this DPA, Customer acts as the <strong className="text-white">Data Controller</strong> (or Business) and Datran acts as the <strong className="text-white">Data Processor</strong> (or Service Provider).
            </p>
            <p>
              The subject matter of the data processing is the provision of zero-knowledge, encrypted file transfer and collaborative space synchronization as requested by Customer. Processing consists exclusively of the automated transmission, encrypted chunk hosting, and scheduled purging of Customer data payloads.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 2 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">02.</span>
              Technical & Organizational Measures (TOMs)
            </h2>
            <p>
              Datran implements rigorous, state-of-the-art security measures to safeguard Customer Data against unauthorized disclosure, alteration, or destruction:
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium">
                  <Shield className="w-4 h-4 text-primary" />
                  Client-Side Zero-Knowledge
                </div>
                <p className="text-xs text-gray-400">
                  AES-256-GCM / DCE2 encryption performed in the client runtime before egress. Decryption keys remain exclusively on Customer endpoints.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium">
                  <Shield className="w-4 h-4 text-primary" />
                  Transport Layer Security
                </div>
                <p className="text-xs text-gray-400">
                  All REST, WebSocket, and QUIC connections are strictly enforced with TLS 1.3 and forward secrecy ciphers.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium">
                  <Shield className="w-4 h-4 text-primary" />
                  Ephemeral Retention
                </div>
                <p className="text-xs text-gray-400">
                  Transfers are permanently removed from storage disks upon expiration or manual user deletion with multi-pass zeroing.
                </p>
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 space-y-2">
                <div className="flex items-center gap-2 text-white font-medium">
                  <Shield className="w-4 h-4 text-primary" />
                  Access & Audit Controls
                </div>
                <p className="text-xs text-gray-400">
                  Hardware token MFA (FIDO2/WebAuthn), least-privilege infrastructure segmentation, and immutable audit logs.
                </p>
              </div>
            </div>
          </section>

          <hr className="border-white/10" />

          {/* Section 3 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">03.</span>
              Subprocessors
            </h2>
            <p>
              Customer provides general authorization for Datran to engage third-party subprocessors to support delivery of the Service. Current subprocessors include:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-gray-300">
              <li><strong className="text-white">Cloudflare, Inc.</strong> — Edge DNS, DDoS protection, CDN edge caching.</li>
              <li><strong className="text-white">Stripe, Inc.</strong> — Payment tokenization and PCI-DSS compliant billing.</li>
              <li><strong className="text-white">Resend Inc.</strong> — Transactional email transmission for account security notices.</li>
            </ul>
            <p>
              Datran imposes contractual data protection obligations on each subprocessor at least as stringent as those set forth in this DPA.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 4 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">04.</span>
              Security Incidents & Breach Notification
            </h2>
            <p>
              In the event of a confirmed Personal Data Breach affecting Customer Data, Datran will notify Customer without undue delay and, where feasible, within <strong className="text-white">72 hours</strong> of becoming aware of the incident.
            </p>
            <p>
              Because Customer payload contents are encrypted with keys Datran does not possess, Customer payloads remain mathematically unreadable even in the theoretical event of underlying storage media exposure.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 5 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">05.</span>
              International Transfers & Standard Contractual Clauses (SCCs)
            </h2>
            <p>
              To the extent Customer transfers Personal Data from the European Economic Area (EEA), the United Kingdom, or Switzerland to countries that do not ensure an adequate level of data protection, the parties hereby incorporate the European Commission's Standard Contractual Clauses (Module 2: Controller-to-Processor) by reference into this DPA.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 6 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">06.</span>
              Execution & Inquiries
            </h2>
            <p>
              Enterprise accounts requiring a countersigned copy of this DPA for vendor due diligence may request an executed agreement by contacting <a href="mailto:compliance@datran.io" className="text-primary underline">compliance@datran.io</a>.
            </p>
          </section>
        </div>

        {/* Quick Nav Footer Links */}
        <div className="mt-8 flex flex-wrap gap-4 justify-between items-center text-sm text-gray-400 px-2">
          <Link href="/terms" className="hover:text-white transition-colors flex items-center gap-1">
            Terms of Service <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <Link href="/privacy" className="hover:text-white transition-colors flex items-center gap-1">
            Privacy Policy <ArrowRight className="w-3.5 h-3.5" />
          </Link>
          <Link href="/security" className="hover:text-white transition-colors flex items-center gap-1">
            Security Policy <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
