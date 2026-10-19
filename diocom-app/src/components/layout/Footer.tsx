import Link from 'next/link';
import { PageProtocolBadge } from '@/components/features/ConnectionInfo';

export default function Footer() {
  return (
    <footer className="mx-auto mt-16 flex w-full max-w-6xl flex-col items-center justify-between gap-4 border-t border-white/10 py-8 text-sm text-gray-400 sm:flex-row">
      <p>© {new Date().getFullYear()} Datran · Encrypted file sharing</p>
      <nav aria-label="Footer" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        <Link href="/" className="rounded hover:text-white">Send files</Link>
        <Link href="/billing" className="rounded hover:text-white">Plans</Link>
        <Link href="/dashboard" className="rounded hover:text-white">My transfers</Link>
        <PageProtocolBadge className="text-xs text-gray-400" />
      </nav>
    </footer>
  );
}
