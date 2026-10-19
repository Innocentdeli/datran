'use client';

import { useEffect } from 'react';
import { FileQuestion } from 'lucide-react';
import type { PublicFile } from '@/db/files';
import { P2PHandler } from '@/lib/network/P2PHandler';

interface DownloadViewerProps {
    fileId: string;
    fileType: 'archive' | 'document' | 'code' | 'unknown';
    metadata?: PublicFile;
}

const LABELS: Record<DownloadViewerProps['fileType'], string> = {
    archive: 'Archives',
    document: 'Documents of this type',
    code: 'Source files',
    unknown: 'Files of this type',
};

/** Placeholder for types without an inline preview (the download button lives in the file card). */
export default function DownloadViewer({ fileId, fileType }: DownloadViewerProps) {
    useEffect(() => {
        // Ask the server to warm its stream cache for this file.
        fetch('/api/prefetch', { method: 'POST', body: JSON.stringify({ fileId }) }).catch(() => { });

        // Join the file's WebRTC swarm (signaling via /api/swarm/announce)
        const p2p = new P2PHandler(fileId);
        p2p.initialize().catch(() => { });
        return () => p2p.destroy();
    }, [fileId]);

    return (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-white/10 px-6 py-10 text-center">
            <FileQuestion className="h-8 w-8 text-gray-400" aria-hidden="true" />
            <p className="text-sm text-gray-300">{LABELS[fileType]} can&apos;t be previewed in the browser.</p>
            <p className="text-xs text-gray-400">Use the download button to save it to your device.</p>
        </div>
    );
}
