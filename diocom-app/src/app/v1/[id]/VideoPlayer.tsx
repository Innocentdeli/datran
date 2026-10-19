'use client';

import { useEffect, useState } from 'react';
import type { PublicFile } from '@/db/files';
import { useE2ESource } from '@/components/viewers/useE2ESource';
import { PreviewError, PreviewSkeleton } from '@/components/viewers/PreviewState';

interface VideoPlayerProps {
    fileId: string;
    metadata?: PublicFile;
}

/** Native <video> controls: keyboard accessible, captions/PiP/fullscreen provided by the browser. */
export default function VideoPlayer({ fileId, metadata }: VideoPlayerProps) {
    const [retry, setRetry] = useState(0);
    const [ready, setReady] = useState<number | null>(null);
    const [mediaError, setMediaError] = useState<number | null>(null);
    const { src, error } = useE2ESource(fileId, metadata, retry);
    const title = metadata?.original_name || 'Shared video';

    useEffect(() => {
        // Ask the server to warm its stream cache for this file.
        fetch('/api/prefetch', { method: 'POST', body: JSON.stringify({ fileId }) }).catch(() => { });
    }, [fileId]);

    if (error || mediaError === retry) {
        return (
            <PreviewError
                className="aspect-video"
                message={error || 'Your browser could not play this video. Download it to watch it with a local player.'}
                onRetry={() => setRetry((r) => r + 1)}
            />
        );
    }

    return (
        <div className="relative aspect-video w-full overflow-hidden rounded-2xl bg-black">
            {ready !== retry && <PreviewSkeleton label="Loading video…" className="absolute inset-0 rounded-none" />}
            {src && (
                <video
                    key={retry}
                    src={src}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label={title}
                    onLoadedMetadata={() => setReady(retry)}
                    onError={() => setMediaError(retry)}
                    className="relative h-full w-full object-contain"
                />
            )}
        </div>
    );
}
