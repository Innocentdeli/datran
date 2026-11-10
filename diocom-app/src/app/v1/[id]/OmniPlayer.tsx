'use client';

import { useState, useEffect, useSyncExternalStore } from 'react';
import { Clock, Download as DownloadIcon, Lock, ShieldCheck, ShieldAlert, KeyRound } from 'lucide-react';
import { detectFileType } from '@/lib/fileUtils';
import { formatDurationShort, formatFileSize } from '@/lib/utils';
import VideoPlayer from './VideoPlayer';
import AudioPlayer from '@/components/viewers/AudioPlayer';
import ImageViewer from '@/components/viewers/ImageViewer';
import PDFViewer from '@/components/viewers/PDFViewer';
import DownloadViewer from '@/components/viewers/DownloadViewer';
import DownloadButton from '@/components/viewers/DownloadButton';
import FileTypeIcon, { fileTypeLabel } from '@/components/ui/FileTypeIcon';
import OtpGate from '@/components/features/OtpGate';
import ReviewFeedbackPanel from '@/components/features/ReviewFeedbackPanel';
import type { PublicFile } from '@/db/files';

interface OmniPlayerProps {
  fileId: string;
  metadata?: PublicFile;
}

// A shared 1 s clock (client only; the server renders no countdown, so there is no hydration mismatch).
function subscribeClock(cb: () => void) {
  const t = setInterval(cb, 1000);
  return () => clearInterval(t);
}
const clientNow = () => Math.floor(Date.now() / 1000) * 1000;
const serverNow = () => null;

function ExpiryCountdown({ expiresAt }: { expiresAt: number }) {
  const now = useSyncExternalStore(subscribeClock, clientNow, serverNow);
  const label = now === null
    ? `Expires ${new Date(expiresAt).toISOString().slice(0, 10)}`
    : expiresAt <= now ? 'Expired' : `Expires in ${formatDurationShort((expiresAt - now) / 1000)}`;
  const soon = now !== null && expiresAt - now < 3600_000;
  return (
    <span
      className={soon ? 'text-amber-300' : undefined}
      title={now === null ? undefined : new Date(expiresAt).toLocaleString()}
    >
      {label}
    </span>
  );
}

function Pill({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'success' | 'warning' }) {
  const tones = {
    neutral: 'border-white/10 bg-white/5 text-gray-200',
    success: 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300',
    warning: 'border-amber-400/25 bg-amber-500/10 text-amber-200',
  };
  return <li className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${tones[tone]}`}>{children}</li>;
}

export default function OmniPlayer({ fileId, metadata }: OmniPlayerProps) {
  // Share ids are random, so detect the type from the original filename (legacy ids embed it).
  const name = metadata?.original_name || decodeURIComponent(fileId).replace(/\.(omni|reactor)\.acs$/, '');
  const fileType = detectFileType(name);
  const isEncrypted = metadata?.is_encrypted === 1;

  const [otpVerified, setOtpVerified] = useState<boolean>(false);
  const [recipientToken, setRecipientToken] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const savedToken = sessionStorage.getItem(`datran_otp_verified_${fileId}`);
      if (savedToken) {
        setOtpVerified(true);
        setRecipientToken(savedToken);
      }
      const params = new URLSearchParams(window.location.search);
      const urlToken = params.get('t');
      if (urlToken) {
        setRecipientToken(urlToken);
        fetch('/api/transfers/track', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fileId, token: urlToken, event: 'open' }),
        }).catch(() => undefined);
      }
    }
  }, [fileId]);

  const isOtpRequired = metadata?.require_email_otp === 1 && !otpVerified;

  let preview: React.ReactNode;
  switch (fileType) {
    case 'video':
      preview = <VideoPlayer fileId={fileId} metadata={metadata} />;
      break;
    case 'audio':
      preview = <AudioPlayer fileId={fileId} metadata={metadata} />;
      break;
    case 'image':
      preview = <ImageViewer fileId={fileId} metadata={metadata} />;
      break;
    case 'pdf':
      preview = <PDFViewer fileId={fileId} metadata={metadata} />;
      break;
    default:
      preview = <DownloadViewer fileId={fileId} fileType={fileType === 'document' || fileType === 'archive' || fileType === 'code' ? fileType : 'unknown'} metadata={metadata} />;
  }

  return (
    <article aria-labelledby="file-name" className="flex flex-col gap-5">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <FileTypeIcon name={name} size="lg" />
          <div className="min-w-0">
            <h1 id="file-name" className="break-words text-xl font-semibold leading-snug text-white sm:text-2xl">{name}</h1>
            <p className="mt-1 text-sm text-gray-300">
              {metadata?.file_size ? formatFileSize(metadata.file_size) : 'Unknown size'} · {fileTypeLabel(name)}
            </p>
          </div>
        </div>
        {!isOtpRequired && (
          <DownloadButton
            fileId={fileId}
            metadata={metadata}
            recipientToken={recipientToken}
            className="w-full sm:w-64 sm:shrink-0"
          />
        )}
      </div>

      <ul className="flex flex-wrap gap-2" aria-label="File details">
        {isEncrypted ? (
          <Pill tone="success"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> End-to-end encrypted</Pill>
        ) : (
          <Pill><ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" /> Encrypted in transit (HTTPS)</Pill>
        )}
        {metadata?.require_email_otp === 1 && (
          <Pill tone="warning"><KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> Recipient OTP Protected</Pill>
        )}
        {metadata?.has_password ? <Pill><Lock className="h-3.5 w-3.5" aria-hidden="true" /> Password protected</Pill> : null}
        {metadata?.expires_at ? (
          <Pill><Clock className="h-3.5 w-3.5" aria-hidden="true" /> <ExpiryCountdown expiresAt={metadata.expires_at} /></Pill>
        ) : (
          <Pill><Clock className="h-3.5 w-3.5" aria-hidden="true" /> Does not expire</Pill>
        )}
        {metadata ? (
          <Pill><DownloadIcon className="h-3.5 w-3.5" aria-hidden="true" /> {metadata.downloads} download{metadata.downloads === 1 ? '' : 's'}</Pill>
        ) : null}
      </ul>

      {isOtpRequired ? (
        <div className="py-6 border-t border-white/10 mt-2">
          <OtpGate
            fileId={fileId}
            fileName={name}
            onVerified={(token) => {
              sessionStorage.setItem(`datran_otp_verified_${fileId}`, token);
              setRecipientToken(token);
              setOtpVerified(true);
              fetch('/api/transfers/track', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileId, token, event: 'open' }),
              }).catch(() => undefined);
            }}
          />
        </div>
      ) : (
        <>
          <section aria-label="Preview">{preview}</section>
          <div className="mt-6 border-t border-white/10 pt-6">
            <ReviewFeedbackPanel fileId={fileId} fileName={name} fileType={fileType} />
          </div>
        </>
      )}
    </article>
  );
}
