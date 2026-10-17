import Link from 'next/link';
import OmniPlayer from './OmniPlayer';
import { FileRepository, toPublicFile } from '@/db/files';
import PasswordGate from '@/components/features/PasswordGate';
import { cookies, headers } from 'next/headers';
import { AnalyticsService } from '@/lib/analytics';
import WormholeConnectWrapper from '@/components/features/WormholeConnectWrapper';
import { AuditLogger } from '@/lib/AuditLogger';
import { hasFileAccess } from '@/lib/crypto/AccessToken';

function isExpiredRecord(expiresAt: number | string | null | undefined): boolean {
  return !!expiresAt && Date.now() > Number(expiresAt);
}

export default async function OmniViewer({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const fileRecord = await FileRepository.findByShareId(id);
  const isExpired = isExpiredRecord(fileRecord?.expires_at);
  const isLocked = !!fileRecord && !hasFileAccess(await cookies(), fileRecord);
  // Only a whitelisted, client-safe projection ever reaches client components.
  const publicFile = fileRecord && !isExpired && !isLocked ? toPublicFile(fileRecord) : undefined;
  const isClientEncrypted = publicFile?.is_encrypted === 1;
  const isCompressed = !!publicFile?.compression_ratio && !publicFile.compression_ratio.startsWith('1.0x');

  if (fileRecord && !isExpired && !isLocked) {
    // Record View
    // Note: In Next.js Server Components, getting IP is tricky without layout middleware, 
    // but we can try headers or just omit it for now/use placeholder.
    const headersList = await headers();
    // Proxy headers are only trusted when TRUST_PROXY=true (same policy as lib/security getClientIp).
    const ip = (process.env.TRUST_PROXY === 'true'
      ? headersList.get('x-forwarded-for')?.split(',')[0]?.trim()
      : undefined) || 'unknown';
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
      details: 'Viewed shared file',
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
            {!fileRecord ? (
              <div className="min-h-[300px] flex items-center justify-center text-gray-400 text-sm">File not found.</div>
            ) : isExpired ? (
              <div className="min-h-[300px] flex items-center justify-center text-gray-400 text-sm">This link has expired.</div>
            ) : isLocked ? (
              <PasswordGate shareId={fileRecord.share_id} />
            ) : (
              <OmniPlayer fileId={id} metadata={publicFile} />
            )}
          </div>

          <div className="w-full max-w-sm mx-auto z-10">
            <WormholeConnectWrapper />
          </div>
        </div>

        {/* Info Grid - Professional Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="glass p-6 rounded-3xl border-white/5 bg-white/[0.02] flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Security</span>
            <span className="text-sm font-semibold text-white">
              {isClientEncrypted ? 'End-to-End Encrypted (AES-GCM, key in link)' : 'Encrypted in transit (HTTPS)'}
            </span>
          </div>
          <div className="glass p-6 rounded-3xl border-white/5 bg-white/[0.02] flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Speed</span>
            <span className="text-sm font-semibold text-primary">Optimized for Stream</span>
          </div>
          <div className="glass p-6 rounded-3xl border-white/5 bg-white/[0.02] flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Storage</span>
            <span className="text-sm font-semibold text-white">
              {isCompressed ? `Lossless · ${publicFile?.compression_ratio}` : 'Stored as uploaded'}
            </span>
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
