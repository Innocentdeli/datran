'use client';

import { useEffect, useId, useRef, useState } from 'react';
import Image from 'next/image';
import dynamic from 'next/dynamic';
import { Copy, Check, ExternalLink, QrCode, AtSign, Smartphone, Mail } from 'lucide-react';
import QRCodeLib from 'qrcode';
import { cn, formatFileSize } from '@/lib/utils';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { buttonClasses } from '@/components/ui/Button';

const UserPushModal = dynamic(() => import('./UserPushModal'), { ssr: false });
const QRSharePanel = dynamic(() => import('./QRSharePanel'), { ssr: false });
const EmailTransferModal = dynamic(() => import('./EmailTransferModal'), { ssr: false });

export interface ShareLinkPanelProps {
  url: string;
  fileName?: string;
  fileSize?: number;
  /** Show the QR code without a toggle (single-file results). */
  qrOpen?: boolean;
  /** Offer "Send to @user" / "QR session" (signed-in users). */
  showSendOptions?: boolean;
}

export default function ShareLinkPanel({ url, fileName, fileSize, qrOpen = false, showSendOptions = false }: ShareLinkPanelProps) {
  const inputId = useId();
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [showQR, setShowQR] = useState(qrOpen);
  const [qrData, setQrData] = useState('');
  const [showPushModal, setShowPushModal] = useState(false);
  const [showQRPair, setShowQRPair] = useState(false);
  const [showEmailModal, setShowEmailModal] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Share id without the #key fragment.
  const shareId = url.split('#')[0].split('/').pop() || '';
  const keyFragment = url.includes('#') ? url.split('#')[1] : undefined;

  useEffect(() => {
    if (!showQR || qrData) return;
    let cancelled = false;
    // Dark-on-light for reliable scanning.
    QRCodeLib.toDataURL(url, { margin: 2, width: 320, color: { dark: '#04121A', light: '#FFFFFF' } })
      .then((d) => { if (!cancelled) setQrData(d); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [showQR, qrData, url]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const handleCopy = async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context / permissions): select the text so it can be copied manually.
      inputRef.current?.select();
      setCopyError(true);
    }
  };

  return (
    <div className="panel p-4 sm:p-5">
      {fileName ? (
        <div className="mb-3 flex items-center gap-3">
          <FileTypeIcon name={fileName} size="sm" />
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white" title={fileName}>{fileName}</p>
            {fileSize !== undefined ? <p className="text-xs text-gray-400">{formatFileSize(fileSize)}</p> : null}
          </div>
        </div>
      ) : null}

      <label htmlFor={inputId} className="sr-only">Share link{fileName ? ` for ${fileName}` : ''}</label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className="h-11 min-w-0 flex-1 rounded-xl border border-white/10 bg-black/40 px-3 font-mono text-sm text-gray-200 focus:border-primary/60 focus:outline-none"
        />
        <button
          type="button"
          onClick={handleCopy}
          className={cn(buttonClasses(copied ? 'success' : 'primary', 'md'), 'sm:w-32')}
        >
          {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="sr-only" aria-live="polite">{copied ? 'Link copied to clipboard' : ''}</p>
      {copyError ? (
        <p className="mt-2 text-xs text-amber-300" role="status">Couldn&apos;t access the clipboard. The link is selected — press Ctrl+C (⌘C) to copy.</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <a href={url} target="_blank" rel="noopener noreferrer" className={buttonClasses('secondary', 'sm')}>
          <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open
        </a>
        {!qrOpen && (
          <button type="button" onClick={() => setShowQR((v) => !v)} aria-expanded={showQR} className={buttonClasses('secondary', 'sm')}>
            <QrCode className="h-4 w-4" aria-hidden="true" /> {showQR ? 'Hide QR code' : 'QR code'}
          </button>
        )}
        <button type="button" onClick={() => setShowEmailModal(true)} className={buttonClasses('secondary', 'sm')}>
          <Mail className="h-4 w-4" aria-hidden="true" /> Send by email
        </button>
      </div>

      {showQR && (
        <div className="mt-4 flex flex-col items-center gap-2">
          {qrData ? (
            <Image
              src={qrData}
              alt="QR code of the share link"
              width={176}
              height={176}
              unoptimized
              className="h-44 w-44 rounded-xl bg-white p-1"
            />
          ) : (
            <div className="skeleton h-44 w-44 rounded-xl" aria-hidden="true" />
          )}
          <p className="text-xs text-gray-400">Scan to open on another device</p>
        </div>
      )}

      {showEmailModal && (
        <EmailTransferModal
          fileId={shareId}
          fileName={fileName || 'Shared file'}
          isOpen={showEmailModal}
          onClose={() => setShowEmailModal(false)}
          keyFragment={keyFragment}
        />
      )}
      {showPushModal && <UserPushModal shareId={shareId} onClose={() => setShowPushModal(false)} />}
      {showQRPair && <QRSharePanel shareId={shareId} onClose={() => setShowQRPair(false)} />}
    </div>
  );
}
