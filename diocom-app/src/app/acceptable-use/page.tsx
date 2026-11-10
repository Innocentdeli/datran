import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Link from 'next/link';
import { AlertOctagon, Ban, ShieldAlert, Flag, CheckCircle2, ArrowRight } from 'lucide-react';

export const metadata = {
  title: 'Acceptable Use Policy | Datran',
  description: 'Standards and guidelines governing acceptable conduct and prohibited content on Datran.',
};

export default function AcceptableUsePage() {
  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main className="mx-auto w-full max-w-4xl flex-1 py-12">
        <div className="panel p-6 sm:p-12 mb-8 relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
          
          <div className="flex items-center gap-3 mb-4 text-primary">
            <AlertOctagon className="w-6 h-6" />
            <span className="text-xs font-mono uppercase tracking-widest text-primary/80">Platform Integrity</span>
          </div>
          
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4 tracking-tight">
            Acceptable Use Policy (AUP)
          </h1>
          <p className="text-gray-300 text-sm sm:text-base leading-relaxed max-w-2xl">
            Effective Date: October 20, 2026. Datran is committed to protecting user privacy, confidentiality, and data security. To maintain trust and protect our network from abuse, all users must adhere to this Acceptable Use Policy.
          </p>
        </div>

        <div className="panel p-6 sm:p-12 space-y-10 text-gray-300 text-sm sm:text-base leading-relaxed">
          {/* Section 1 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">01.</span>
              Zero-Tolerance Prohibited Activities
            </h2>
            <p>
              Datran strictly prohibits using the platform for any unlawful, predatory, or harmful activities. Violators will face immediate, permanent account termination and referral to pertinent authorities:
            </p>
            <div className="space-y-3 pt-2">
              <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-200">
                <strong className="text-white block mb-1">Child Sexual Exploitation & Abuse (CSAM):</strong>
                Zero tolerance. Any transmission or storage of CSAM will result in instantaneous link disablement, account termination, and mandatory reporting to the National Center for Missing & Exploited Children (NCMEC) and relevant law enforcement bodies.
              </div>

              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-200">
                <strong className="text-white block mb-1">Malware & Threat Dissemination:</strong>
                Uploading or disseminating malicious binaries, ransomware, botnet droppers, trojans, exploit kits, infostealers, or obfuscated dual-extension executables (.pdf.exe) is prohibited. All unencrypted ingest pipelines actively run heuristic and antivirus signature verification.
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-gray-300">
                <strong className="text-white block mb-1">Non-Consensual Imagery & Doxxing:</strong>
                Sharing non-consensual intimate imagery, personally identifiable information for harassment purposes (doxxing), or threats of violence is strictly prohibited.
              </div>

              <div className="p-4 rounded-xl bg-white/5 border border-white/10 text-gray-300">
                <strong className="text-white block mb-1">Fraud & Credential Harvesting:</strong>
                Hosting phishing kits, stolen credit card databases, credential-stuffing dumps, or deceptive financial scams.
              </div>
            </div>
          </section>

          <hr className="border-white/10" />

          {/* Section 2 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">02.</span>
              Network Security & Fair Use
            </h2>
            <p>
              You agree not to disrupt or degrade the integrity of the Datran network or its participants. Specifically, you may not:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-gray-300">
              <li>Deploy automated scripts, scrapers, or spiders that flood the ingest APIs or bypass per-IP rate limits.</li>
              <li>Perform denial-of-service (DoS or DDoS) attacks against signaling nodes, relays, or web edge workers.</li>
              <li>Circumvent storage quotas, subscription boundaries, or file expiration timers through forged headers or session manipulation.</li>
              <li>Distribute malicious links via unsolicited mass communications (spamming).</li>
            </ul>
          </section>

          <hr className="border-white/10" />

          {/* Section 3 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">03.</span>
              Enforcement & Moderation Queue
            </h2>
            <p>
              To enforce this policy without violating cryptographic privacy:
            </p>
            <ul className="list-disc pl-6 space-y-2 text-gray-300">
              <li><strong className="text-white">User Reporting:</strong> Every download link features an interactive "Report this link" modal allowing recipients or security researchers to submit URLs for immediate moderation review.</li>
              <li><strong className="text-white">Admin Moderation:</strong> Our automated queue flags elevated report volume or malware alerts for swift intervention, disabling link access within minutes.</li>
              <li><strong className="text-white">Disabled Link State:</strong> When a link is flagged or disabled for abuse, all HTTP streaming attempts immediately return HTTP 410 Gone, halting data transfer permanently.</li>
            </ul>
          </section>

          <hr className="border-white/10" />

          {/* Section 4 */}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold text-white tracking-tight flex items-center gap-2">
              <span className="text-primary font-mono text-sm">04.</span>
              How to Report Violations
            </h2>
            <p>
              If you come across a Datran transfer link that violates this policy:
            </p>
            <ol className="list-decimal pl-6 space-y-2 text-gray-300">
              <li>Click the <strong className="text-white">"Report this link"</strong> button located at the bottom of the download page.</li>
              <li>Alternatively, email our safety team directly at <a href="mailto:abuse@datran.io" className="text-primary underline">abuse@datran.io</a> with the transfer URL and specific nature of the violation.</li>
              <li>For intellectual property or copyright claims, submit a formal notice via our <Link href="/dmca" className="text-primary underline">DMCA Takedown Portal</Link>.</li>
            </ol>
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
          <Link href="/dmca" className="hover:text-white transition-colors flex items-center gap-1">
            DMCA Copyright Notices <ArrowRight className="w-3.5 h-3.5" />
          </Link>
        </div>
      </main>

      <Footer />
    </div>
  );
}
