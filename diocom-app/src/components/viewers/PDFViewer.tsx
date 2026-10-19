'use client';

import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { PublicFile } from '@/db/files';
import { useE2ESource } from './useE2ESource';
import { PreviewError, PreviewSkeleton } from './PreviewState';

interface PDFViewerProps {
    fileId: string;
    metadata?: PublicFile;
}

export default function PDFViewer({ fileId, metadata }: PDFViewerProps) {
    const [retry, setRetry] = useState(0);
    const [loaded, setLoaded] = useState<number | null>(null);
    const { src, error } = useE2ESource(fileId, metadata, retry);
    const title = metadata?.original_name || 'PDF document';

    if (error) {
        return <PreviewError className="min-h-64" message={error} onRetry={() => setRetry((r) => r + 1)} />;
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="relative h-[70vh] min-h-80 w-full overflow-hidden rounded-2xl border border-white/10 bg-[#1a1a1a]">
                {loaded !== retry && <PreviewSkeleton label="Loading document…" className="absolute inset-0 rounded-none" />}
                {src && (
                    <iframe
                        key={retry}
                        src={`${src}#navpanes=0`}
                        title={`Preview of ${title}`}
                        onLoad={() => setLoaded(retry)}
                        className="relative h-full w-full border-0"
                    />
                )}
            </div>
            {src && (
                <a
                    href={src}
                    target="_blank"
                    rel="noopener"
                    className="inline-flex h-9 items-center gap-1.5 self-end rounded-lg px-2.5 text-xs font-medium text-gray-300 hover:bg-white/5 hover:text-white"
                >
                    <ExternalLink className="h-4 w-4" aria-hidden="true" /> Open in new tab
                </a>
            )}
        </div>
    );
}
