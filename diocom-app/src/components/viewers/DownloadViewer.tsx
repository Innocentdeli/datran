import { useState, useEffect } from 'react';
import { Download, FileArchive, ShieldCheck, Loader2, Activity } from 'lucide-react';
import { formatFileSize } from '@/lib/utils';
import { getFileIcon } from '@/lib/fileUtils';
import Button from '@/components/ui/Button';
import Badge from '@/components/ui/Badge';
import { downloadFile, subscribeE2EErrors } from '@/lib/crypto/e2eClient';
import type { PublicFile } from '@/db/files';
import { P2PHandler } from '@/lib/network/P2PHandler';

interface DownloadViewerProps {
    fileId: string;
    fileType: 'archive' | 'document' | 'code' | 'unknown';
    metadata?: PublicFile;
}

export default function DownloadViewer({ fileId, fileType, metadata }: DownloadViewerProps) {
    const [isDecrypting, setIsDecrypting] = useState(false);
    const [peerActive, setPeerActive] = useState(false);
    const [downloadError, setDownloadError] = useState<string | null>(null);
    const cleanName = metadata?.original_name || decodeURIComponent(fileId).replace(/\.(omni|reactor)\.acs$/, '');
    const icon = getFileIcon(fileType);

    // No fabricated fallback stats when metadata is missing
    const ratio = metadata?.compression_ratio || '—';
    const speed = metadata?.compression_speed || '—';

    const isEncrypted = metadata?.is_encrypted === 1;

    useEffect(() => {
        // Trigger Swarm Pre-fetch
        fetch('/api/prefetch', {
            method: 'POST',
            body: JSON.stringify({ fileId })
        }).catch(() => { });

        // Join the file's WebRTC swarm (signaling via /api/swarm/announce)
        const p2p = new P2PHandler(fileId);
        let disposed = false;
        p2p.initialize().then(() => { if (!disposed) setPeerActive(true); }).catch(() => { });

        return () => {
            disposed = true;
            p2p.destroy();
        };
    }, [fileId]);

    // Mid-stream failures of a Service Worker download (tampered/truncated data, missing key) are reported here.
    useEffect(() => subscribeE2EErrors(fileId, (message) => setDownloadError(message)), [fileId]);

    const handleDownload = async () => {
        setDownloadError(null);
        setIsDecrypting(isEncrypted);
        try {
            // DCE2 streams through the decrypting Service Worker (or File System Access); legacy v1 decrypts in memory.
            await downloadFile(fileId, metadata);
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return; // save dialog cancelled
            console.error('Download failed:', err);
            setDownloadError(err instanceof Error ? err.message : 'Secure decryption failed.');
        } finally {
            setIsDecrypting(false);
        }
    };

    return (
        <div className="flex flex-col items-center justify-center py-20 px-8">
            {/* File Icon */}
            <div className="w-32 h-32 bg-primary/10 rounded-3xl flex items-center justify-center mb-8 border border-primary/20 relative">
                <span className="text-6xl">{icon}</span>
                {isEncrypted && (
                    <div className="absolute -top-2 -right-2 bg-success text-black p-1.5 rounded-full shadow-lg">
                        <ShieldCheck className="w-4 h-4" />
                    </div>
                )}
            </div>

            {/* File Info */}
            <h3 className="text-xl font-bold mb-2 text-center max-w-md truncate">
                {cleanName}
            </h3>

            <div className="flex gap-2 mb-8">
                <Badge variant="primary" size="sm">
                    {fileType.toUpperCase()}
                </Badge>
                {isEncrypted ? (
                    <Badge variant="success" size="sm" className="gap-1">
                        <ShieldCheck className="w-3 h-3" /> Zero-Knowledge
                    </Badge>
                ) : (
                    <Badge variant="neutral" size="sm">
                        Compressed
                    </Badge>
                )}

                {peerActive && (
                    <Badge variant="primary" size="sm" className="gap-1 animate-pulse">
                        <Activity className="w-3 h-3" /> Swarm Active
                    </Badge>
                )}
            </div>

            {/* Description */}
            <p className="text-sm text-gray-300 text-center max-w-md mb-8">
                {isEncrypted
                    ? 'This payload is secured with Zero-Knowledge encryption. Decryption will verify the key in your URL before download.'
                    : 'This file is ready for download. Click below to save it to your device.'
                }
            </p>

            {/* Download Button */}
            <Button
                onClick={handleDownload}
                variant="primary"
                size="lg"
                className="gap-3 min-w-[220px]"
                disabled={isDecrypting}
            >
                {isDecrypting ? (
                    <>
                        <Loader2 className="w-5 h-5 animate-spin" />
                        Decrypting...
                    </>
                ) : (
                    <>
                        <Download className="w-5 h-5" />
                        {isEncrypted ? 'Secure Decrypt & Save' : 'Download to Device'}
                    </>
                )}
            </Button>

            {downloadError && (
                <p className="mt-4 text-sm text-red-400 text-center max-w-md" role="alert">{downloadError}</p>
            )}

            {/* Stats */}
            <div className="mt-12 grid grid-cols-3 gap-6 text-center">
                <div>
                    <p className="text-[10px] text-gray-500 uppercase font-bold mb-1">Security</p>
                    <p className="text-sm font-bold text-primary">{isEncrypted ? 'AES-256' : 'TLS 1.3'}</p>
                </div>
                <div>
                    <p className="text-[10px] text-gray-500 uppercase font-bold mb-1">Privacy</p>
                    <p className="text-sm font-bold text-green-400">{isEncrypted ? 'ZK-Blind' : 'Private'}</p>
                </div>
                <div>
                    <p className="text-[10px] text-gray-500 uppercase font-bold mb-1">Speed</p>
                    <p className="text-sm font-bold text-white">{speed}</p>
                </div>
            </div>
        </div>
    );
}
