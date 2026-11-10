'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { UploadCloud, Radio, FolderOpen, Inbox, CreditCard } from 'lucide-react';
import AuthStatus from '@/components/features/AuthStatus';
import InboxPanel from '@/components/features/InboxPanel';
import BrandMark from '@/components/ui/BrandMark';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/send', label: 'Send', icon: UploadCloud },
  { href: '/radar', label: 'Beam', icon: Radio },
  { href: '/spaces', label: 'Spaces', icon: FolderOpen },
  { href: '/dashboard/requests', label: 'Requests', icon: Inbox },
  { href: '/billing', label: 'Pricing', icon: CreditCard },
];

export default function Header() {
  const pathname = usePathname();
  const { status } = useSession();

  return (
    <header className="relative z-30 mx-auto mb-10 flex w-full max-w-6xl items-center justify-between gap-3 sm:mb-14">
      <Link href="/" className="flex shrink-0 items-center gap-3 rounded-xl">
        <BrandMark />
        <span className="text-lg font-bold tracking-tight text-white">Datran</span>
      </Link>

      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        <nav aria-label="Main" className="flex items-center gap-0.5 sm:gap-1">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname?.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                aria-label={label}
                className={cn(
                  'flex h-10 items-center gap-1.5 rounded-xl px-2.5 text-sm font-medium transition-colors sm:px-3',
                  active ? 'bg-white/10 text-white' : 'text-gray-300 hover:bg-white/5 hover:text-white'
                )}
              >
                <Icon className="h-4 w-4" aria-hidden="true" />
                <span className="hidden md:inline">{label}</span>
              </Link>
            );
          })}
        </nav>

        <span className="mx-1 hidden h-6 w-px bg-white/10 sm:block" aria-hidden="true" />

        {status === 'authenticated' ? <InboxPanel /> : null}
        <AuthStatus />
      </div>
    </header>
  );
}
