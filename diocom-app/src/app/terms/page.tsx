import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Link from 'next/link';
import { Shield, FileText, CheckCircle2, AlertTriangle, ArrowRight } from 'lucide-react';

export const metadata = {
  title: 'Terms of Service | Datran',
  description: 'Terms and conditions governing the use of the Datran zero-knowledge file sharing platform.',
};

export default function TermsPage() {
  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main className="mx-auto w-full max-w-4xl flex-1 py-12">
        <div className="panel p-6 sm:p-12 mb-8 relative overflow-hidden">
          {/* Subtle Glow */}
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
          
          <div className="flex items-center gap-3 mb-4 text-primary">
            <FileText className="w-6 h-6" />
            <span className="text-xs font-mono uppercase tracking-widest text-primary/80">Legal Framework</span>
          </div>
          
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4 tracking-tight">
            Terms of Service
          </h1>
          <p className="text-gray-300 text-sm sm:text-base leading-relaxed max-w-2xl">
            Effective Date: October 20, 2026. By accessing or using Datran, you agree to be bound by these Terms of Service. If you do not agree to these terms, do not access or use the platform.
          </p>
        </div>

        <div className="panel p-6 sm:p-12 space-y-10 text-gray-300 text-sm sm:text-base leading-relaxed">
          {/* Section 1 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">01.</span>
              The Zero-Knowledge Transfer Service
            </h2>
            <p>
              Datran provides end-to-end encrypted file transfer, storage, and synchronization protocols (the "Service"). Under our zero-knowledge architecture, client-side encryption occurs directly within your browser or mobile runtime before bytes leave your device.
            </p>
            <p>
              Because Datran does not possess, store, or escrow your decryption keys, you acknowledge that <strong className="text-white">lost encryption keys or transfer passphrases cannot be recovered by Datran under any circumstances</strong>. You maintain exclusive responsibility for preserving access credentials and transfer keys.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 2 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">02.</span>
              Account Creation & Credentials
            </h2>
            <p>
              You may use public transfer features anonymously within designated rate and size limits, or register an authenticated account for expanded storage, team spaces, and custom retention windows.
            </p>
            <p>
              You are responsible for safeguarding your authentication credentials, WebAuthn passkeys, and API tokens. You must notify us immediately at <a href="mailto:security@datran.io" className="text-primary underline">security@datran.io</a> if you suspect unauthorized access to your account.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 3 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">03.</span>
              Acceptable Use & Prohibited Conduct
            </h2>
            <p>
              You agree not to misuse the Service. Specifically, you agree not to use the Service to upload, store, distribute, or transmit:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-gray-300">
              <li>Child sexual abuse material (CSAM) or any exploitation of minors.</li>
              <li>Malicious software, unencrypted malware, trojans, ransomware, or botnet command-and-control payloads.</li>
              <li>Material that infringes upon third-party intellectual property rights, trademarks, or trade secrets without authorization.</li>
              <li>Files intended to execute denial-of-service (DoS) attacks, automated scanning, or infrastructure compromise.</li>
            </ul>
            <p>
              Violations of these standards will result in immediate link termination, file disabling, and account bans. Please review our full <Link href="/acceptable-use" className="text-primary underline">Acceptable Use Policy</Link>.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 4 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">04.</span>
              Intellectual Property & Ownership
            </h2>
            <p>
              <strong className="text-white">Your Content:</strong> You retain complete ownership of, and full intellectual property rights to, any files, metadata, and data you upload to Datran. Datran claims zero ownership, license, or distribution rights over your data beyond the temporary, automated technical transmission required to deliver the Service.
            </p>
            <p>
              <strong className="text-white">Datran IP:</strong> The Datran logos, visual interface, user interface components, and proprietary protocol implementations are protected by copyright and intellectual property laws.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 5 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">05.</span>
              Copyright & DMCA Takedown Policy
            </h2>
            <p>
              Datran respects intellectual property rights and adheres to the Digital Millennium Copyright Act (17 U.S.C. § 512). If you believe your copyrighted work has been shared without permission via a Datran link, submit a formal notice through our <Link href="/dmca" className="text-primary underline">DMCA Takedown Portal</Link>. Valid notices result in immediate disabling of access to the specified transfer links.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 6 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">06.</span>
              Subscriptions, Billing & Fair Use
            </h2>
            <p>
              Paid tiers (Pro, Team, Enterprise) are billed on a recurring monthly or annual basis via Stripe. You may cancel at any time through your Billing Dashboard. Cancellations take effect at the conclusion of the current prepaid billing period.
            </p>
            <p>
              Transfers exceeding tier storage caps or bandwidth allocations may be rate-limited or temporarily throttled until the next billing cycle. Files stored beyond designated expiry timestamps are automatically purged from storage nodes without permanent archives.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 7 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">07.</span>
              Disclaimers & Limitation of Liability
            </h2>
            <p className="uppercase text-xs tracking-wider text-gray-400">
              The service is provided "as is" and "as available" without warranties of any kind, whether express or implied.
            </p>
            <p>
              To the maximum extent permitted by applicable law, Datran and its operators shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits, data, use, goodwill, or other intangible losses resulting from: (a) your access to or use of (or inability to access or use) the Service; (b) any unauthorized access to or alteration of your transmissions or data; or (c) lost transfer encryption keys.
            </p>
          </section>

          <hr className="border-white/10" />

          {/* Section 8 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">08.</span>
              Contact & Inquiries
            </h2>
            <p>
              Questions regarding these Terms should be directed to <a href="mailto:legal@datran.io" className="text-primary underline">legal@datran.io</a> or sent via our security desk.
            </p>
          </section>
        </div>

        {/* Quick Nav Footer Links */}
        <div className="mt-8 flex flex-wrap gap-4 justify-between items-center text-sm text-gray-400 px-2">
          <Link href="/privacy" className="hover:text-white transition-colors flex items-center gap-1">
            Privacy Policy <ArrowRight className="w-3.5 h-3.5" />
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
