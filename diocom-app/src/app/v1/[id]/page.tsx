import { ShieldCheck, Database, Activity, ChevronLeft } from 'lucide-react';
import Link from 'next/link';
import OmniPlayer from './OmniPlayer';
import StatCard from '@/components/ui/StatCard';
import { FileRepository } from '@/db/files';
import PasswordGate from '@/components/features/PasswordGate';
import { cookies, headers } from 'next/headers';
import { AnalyticsService } from '@/lib/analytics';
import WormholeConnectWrapper from '@/components/features/WormholeConnectWrapper';
import { AuditLogger } from '@/lib/AuditLogger';

export default async function OmniViewer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fileRecord = await FileRepository.findByShareId(id);

  if (fileRecord) {
    // Record View
    // Note: In Next.js Server Components, getting IP is tricky without layout middleware, 
    // but we can try headers or just omit it for now/use placeholder.
    const headersList = await headers();
    const ip = headersList.get('x-forwarded-for') || 'unknown';
    const ua = headersList.get('user-agent');

    await AnalyticsService.record({
      fileId: fileRecord.id,
      eventType: 'view',
      ipAddress: ip,
      userAgent: ua || undefined
    });

    // Record Audit event
    await AuditLogger.record({
      action: 'FILE_VIEW',
      resource: id,
      details: `Viewed file: ${fileRecord.original_name}`,
      ipAddress: ip
    });
  }

  return (
    <div className="min-h-screen bg-[#0A0F1A] text-white p-4 sm:p-8 flex flex-col items-center justify-center font-sans relative overflow-hidden">
      {/* Background Glow */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="max-w-4xl w-full z-10 flex flex-col gap-8">
        {/* Header / Brand */}
        <div className="flex justify-between items-center">
          <Link href="/" className="flex items-center gap-3 group">
            <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center font-black text-white text-base shadow-lg transition-transform group-hover:scale-110">
              T
            </div>
            <span className="text-lg font-bold tracking-tight text-white">Datran</span>
          </Link>

          <div className="flex items-center gap-4 bg-white/5 px-4 py-2 rounded-full border border-white/10">
            <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
            <span className="text-[10px] font-mono text-gray-400 uppercase tracking-widest">Secure Link</span>
          </div>
        </div>

        {/* Decoder Container - Focused Card */}
        <div className="relative group flex flex-col gap-6">
          <div className="absolute -inset-1 bg-gradient-to-r from-primary/10 to-secondary/10 rounded-[40px] blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-1000 pointer-events-none" />
          
          <div className="glass p-2 rounded-[40px] shadow-2xl transition-all duration-700 bg-black/40 border-white/5 relative overflow-hidden z-10">
            <OmniPlayer fileId={id} metadata={fileRecord || undefined} />
          </div>

          <div className="w-full max-w-sm mx-auto z-10">
            <WormholeConnectWrapper />
          </div>
        </div>

        {/* Info Grid - Professional Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="glass p-6 rounded-3xl border-white/5 bg-white/[0.02] flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Security</span>
            <span className="text-sm font-semibold text-white">End-to-End Encrypted</span>
          </div>
          <div className="glass p-6 rounded-3xl border-white/5 bg-white/[0.02] flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Speed</span>
            <span className="text-sm font-semibold text-primary">Optimized for Stream</span>
          </div>
          <div className="glass p-6 rounded-3xl border-white/5 bg-white/[0.02] flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Integrity</span>
            <span className="text-sm font-semibold text-success">Verified Bit-Perfect</span>
          </div>
        </div>

        {/* Footer Attribution */}
        <p className="text-center text-[10px] text-gray-600 font-medium uppercase tracking-[0.4em] opacity-40 mt-4">
          Sent via Datran Premium Transfer
        </p>
      </div>
    </div>
  );
}
