'use client';

import { useEffect, useRef, useState } from 'react';
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
    const videoRef = useRef<HTMLVideoElement>(null);
    const { src, error } = useE2ESource(fileId, metadata, retry);
    const title = metadata?.original_name || 'Shared video';

    useEffect(() => {
        // Ask the server to warm its stream cache for this file.
        fetch('/api/prefetch', { method: 'POST', body: JSON.stringify({ fileId }) }).catch(() => { });
    }, [fileId]);

    useEffect(() => {
        const handleSeek = (e: Event) => {
            const customEvent = e as CustomEvent<{ time: number }>;
            if (videoRef.current && customEvent.detail?.time != null) {
                videoRef.current.currentTime = customEvent.detail.time;
                videoRef.current.play().catch(() => {});
            }
        };
        window.addEventListener('datran:seek-media', handleSeek);
        return () => window.removeEventListener('datran:seek-media', handleSeek);
    }, []);

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
                    ref={videoRef}
                    key={retry}
                    src={src}
                    controls
                    playsInline
                    preload="metadata"
                    aria-label={title}
                    onLoadedMetadata={() => setReady(retry)}
                    onTimeUpdate={() => {
                        if (typeof window !== 'undefined' && videoRef.current) {
                            (window as unknown as { __DATRAN_CURRENT_MEDIA_TIME?: number }).__DATRAN_CURRENT_MEDIA_TIME = videoRef.current.currentTime;
                        }
                    }}
                    onError={() => setMediaError(retry)}
                    className="relative h-full w-full object-contain"
                />
            )}
        </div>
    );
}
