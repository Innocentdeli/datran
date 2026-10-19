import Link from 'next/link';
import OmniPlayer from './OmniPlayer';
import { FileRepository, toPublicFile } from '@/db/files';
import PasswordGate from '@/components/features/PasswordGate';
import { cookies, headers } from 'next/headers';
import { AnalyticsService } from '@/lib/analytics';
import WormholeConnectWrapper from '@/components/features/WormholeConnectWrapper';
import { AuditLogger } from '@/lib/AuditLogger';
import { hasFileAccess } from '@/lib/crypto/AccessToken';
import BrandMark from '@/components/ui/BrandMark';
import { buttonClasses } from '@/components/ui/Button';
import { Clock, FileQuestion, Upload } from 'lucide-react';

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
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <header className="mx-auto mb-8 flex w-full max-w-4xl items-center justify-between gap-3">
        <Link href="/" className="flex items-center gap-2.5 rounded-xl">
          <BrandMark size="sm" />
          <span className="text-base font-bold tracking-tight text-white">Datran</span>
        </Link>
        <Link href="/" className={buttonClasses('secondary', 'sm')}>
          <Upload className="h-4 w-4" aria-hidden="true" /> Send a file
        </Link>
      </header>

      <main id="main" className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6">
        <div className="panel p-4 sm:p-6">
          {!fileRecord ? (
            <LinkState
              icon={<FileQuestion className="h-7 w-7" aria-hidden="true" />}
              title="This link doesn't exist"
              body="Check that you copied the whole link. It may also have been deleted by its owner."
            />
          ) : isExpired ? (
            <LinkState
              icon={<Clock className="h-7 w-7" aria-hidden="true" />}
              title="This link has expired"
              body="Shared files are removed when their link expires. Ask the sender to share it again."
            />
          ) : isLocked ? (
            <PasswordGate shareId={fileRecord.share_id} />
          ) : (
            <OmniPlayer fileId={id} metadata={publicFile} />
          )}
        </div>

        {publicFile ? (
          <details className="group panel px-4 py-3 text-sm sm:px-6">
            <summary className="cursor-pointer select-none rounded font-medium text-gray-200 marker:text-gray-400">
              Security &amp; connection details
            </summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <dl className="flex flex-col gap-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-400">Encryption</dt>
                  <dd className="text-right text-gray-200">{isClientEncrypted ? 'End-to-end (AES-GCM, key in link)' : 'In transit (HTTPS)'}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-400">Storage</dt>
                  <dd className="text-right text-gray-200">{isCompressed ? `Lossless compression · ${publicFile.compression_ratio}` : 'Stored as uploaded'}</dd>
                </div>
              </dl>
              <WormholeConnectWrapper />
            </div>
          </details>
        ) : null}
      </main>

      <footer className="mx-auto mt-12 w-full max-w-4xl border-t border-white/10 py-6 text-center text-sm text-gray-400">
        Shared with Datran · <Link href="/" className="font-medium text-primary underline-offset-4 hover:underline">Send your own files, end-to-end encrypted</Link>
      </footer>
    </div>
  );
}

function LinkState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-4 py-10 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/5 text-gray-300">{icon}</span>
      <h1 className="text-xl font-semibold text-white">{title}</h1>
      <p className="max-w-sm text-sm text-gray-300">{body}</p>
      <Link href="/" className={buttonClasses('primary', 'md', 'mt-2')}>Send a file</Link>
    </div>
  );
}
