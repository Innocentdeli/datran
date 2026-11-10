'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { downloadFile, subscribeE2EErrors } from '@/lib/crypto/e2eClient';
import type { PublicFile } from '@/db/files';
import { buttonClasses } from '@/components/ui/Button';
import { cn, formatFileSize } from '@/lib/utils';

/** Primary download action. Encrypted files are decrypted locally while they are saved. */
export default function DownloadButton({ fileId, metadata, recipientToken, className }: { fileId: string; metadata?: PublicFile; recipientToken?: string | null; className?: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const isEncrypted = metadata?.is_encrypted === 1;

    // Mid-stream failures of a Service Worker download (tampered/truncated data, missing key) are reported here.
    useEffect(() => subscribeE2EErrors(fileId, (message) => setError(message)), [fileId]);

    const handleDownload = async () => {
        setError(null);
        setBusy(true);
        try {
            // DCE2 streams through the decrypting Service Worker (or File System Access); legacy v1 decrypts in memory.
            await downloadFile(fileId, metadata);
            if (recipientToken) {
                fetch('/api/transfers/track', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileId, token: recipientToken, event: 'download' }),
                }).catch(() => undefined);
            }
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return; // save dialog cancelled
            console.error('Download failed:', err);
            setError(err instanceof Error ? err.message : 'The download failed.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={cn('flex flex-col gap-2', className)}>
            <button type="button" onClick={handleDownload} disabled={busy} className={buttonClasses('primary', 'lg', 'w-full')}>
                {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <Download className="h-5 w-5" aria-hidden="true" />}
                {busy ? (isEncrypted ? 'Decrypting…' : 'Starting download…') : `Download${metadata?.file_size ? ` · ${formatFileSize(metadata.file_size)}` : ''}`}
            </button>
            <p className="sr-only" aria-live="polite">{busy ? 'Download started' : ''}</p>
            {error && (
                <p className="rounded-xl border border-red-400/25 bg-red-500/10 px-3 py-2 text-sm text-red-200" role="alert">
                    {error}
                </p>
            )}
        </div>
    );
}
