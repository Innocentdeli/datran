import Link from 'next/link';
import { ShieldCheck, Lock } from 'lucide-react';

export default function Footer() {
  return (
    <footer className="mx-auto mt-16 w-full max-w-6xl border-t border-white/10 py-12 text-sm text-gray-400">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-8 mb-8 px-2">
        <div>
          <h4 className="text-xs font-mono uppercase tracking-widest text-white mb-3 flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-primary" />
            Product
          </h4>
          <ul className="space-y-2 text-xs sm:text-sm">
            <li><Link href="/" className="hover:text-white transition-colors">Send Files</Link></li>
            <li><Link href="/dashboard/requests" className="hover:text-white transition-colors">File Requests</Link></li>
            <li><Link href="/billing" className="hover:text-white transition-colors">Plans &amp; Pricing</Link></li>
            <li><Link href="/dashboard" className="hover:text-white transition-colors">My Transfers</Link></li>
            <li><Link href="/dashboard/api-keys" className="hover:text-white transition-colors">Developer API</Link></li>
            <li>
              <Link href="/status" className="hover:text-white transition-colors flex items-center gap-1.5 text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                System Status
              </Link>
            </li>
          </ul>
        </div>

        <div>
          <h4 className="text-xs font-mono uppercase tracking-widest text-white mb-3 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-primary" />
            Security &amp; Trust
          </h4>
          <ul className="space-y-2 text-xs sm:text-sm">
            <li><Link href="/security" className="hover:text-white transition-colors">Security Architecture</Link></li>
            <li><Link href="/security#hall-of-fame" className="hover:text-white transition-colors">Vulnerability Disclosure</Link></li>
            <li><Link href="/.well-known/security.txt" className="hover:text-white transition-colors font-mono text-xs">security.txt</Link></li>
            <li><Link href="/dmca" className="hover:text-white transition-colors">DMCA Takedown</Link></li>
          </ul>
        </div>

        <div>
          <h4 className="text-xs font-mono uppercase tracking-widest text-white mb-3">
            Legal &amp; Compliance
          </h4>
          <ul className="space-y-2 text-xs sm:text-sm">
            <li><Link href="/terms" className="hover:text-white transition-colors">Terms of Service</Link></li>
            <li><Link href="/privacy" className="hover:text-white transition-colors">Privacy Policy</Link></li>
            <li><Link href="/acceptable-use" className="hover:text-white transition-colors">Acceptable Use Policy</Link></li>
            <li><Link href="/dpa" className="hover:text-white transition-colors">DPA (Data Processing)</Link></li>
          </ul>
        </div>

        <div>
          <h4 className="text-xs font-mono uppercase tracking-widest text-white mb-3">
            Privacy by Design
          </h4>
          <p className="text-xs text-gray-400 leading-relaxed mb-3">
            End-to-end, client-side encryption. We never have access to your decryption keys or unencrypted file contents.
          </p>
        </div>
      </div>

      <div className="border-t border-white/5 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-gray-500 px-2">
        <p>© {new Date().getFullYear()} Datran Inc. All rights reserved.</p>
        <div className="flex items-center gap-4">
          <Link href="/privacy" className="hover:text-gray-400 transition-colors">Privacy</Link>
          <span>•</span>
          <Link href="/terms" className="hover:text-gray-400 transition-colors">Terms</Link>
          <span>•</span>
          <Link href="/status" className="hover:text-gray-400 transition-colors">Status</Link>
        </div>
      </div>
    </footer>
  );
}
