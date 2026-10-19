'use client';

import { config } from '@/config';
import AuthStatus from '@/components/features/AuthStatus';
import Link from 'next/link';
import InboxPanel from '@/components/features/InboxPanel';
import { Zap, FolderOpen, CreditCard } from 'lucide-react';

export default function Header() {
  return (
    <div className="max-w-7xl w-full flex flex-col sm:flex-row justify-between items-center gap-6 mb-16 sm:mb-20 relative z-30">
      <Link href="/" className="flex items-center gap-4 group">
        <div className="w-10 h-10 bg-primary rounded-xl flex items-center justify-center font-black text-white text-xl shadow-lg ring-4 ring-primary/10 transition-transform group-hover:scale-105">
          T
        </div>
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight leading-none text-white">
            Datran
          </h1>
          <p className="text-[10px] uppercase tracking-widest text-gray-300 font-medium mt-1">Premium Data Transfer</p>
        </div>
      </Link>

      <div className="flex items-center gap-3 text-xs text-gray-400 font-medium">
        {/* Nav Links */}
        <Link
          href="/lobby"
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-medium hover:bg-blue-500/15 transition-colors"
        >
          <Zap size={12} />
          Live Lobby
        </Link>
        <Link
          href="/spaces"
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-medium hover:bg-violet-500/15 transition-colors"
        >
          <FolderOpen size={12} />
          Spaces
        </Link>
        <Link
          href="/billing"
          className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary/10 border border-primary/20 text-primary text-xs font-medium hover:bg-primary/15 transition-colors"
        >
          <CreditCard size={12} />
          Billing
        </Link>

        {/* Inbox Panel */}
        <InboxPanel />

        <AuthStatus />

        <div className="hidden sm:flex items-center gap-2 bg-white/5 px-3 py-1.5 rounded-full border border-white/10">
          <div className="w-1.5 h-1.5 rounded-full bg-success" />
          <span className="text-[10px] font-mono text-gray-200">System Ready</span>
        </div>
      </div>
    </div>
  );
}
