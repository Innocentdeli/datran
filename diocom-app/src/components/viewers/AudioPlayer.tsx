'use client';

import { useState } from 'react';
import { Music } from 'lucide-react';
import type { PublicFile } from '@/db/files';
import { useE2ESource } from './useE2ESource';
import { PreviewError, PreviewSkeleton } from './PreviewState';

interface AudioPlayerProps {
    fileId: string;
    metadata?: PublicFile;
}

/** Native <audio> controls (keyboard and screen-reader accessible out of the box). */
export default function AudioPlayer({ fileId, metadata }: AudioPlayerProps) {
    const [retry, setRetry] = useState(0);
    const [mediaError, setMediaError] = useState<number | null>(null);
    const { src, error } = useE2ESource(fileId, metadata, retry);
    const title = metadata?.original_name || 'Shared audio';

    if (error || mediaError === retry) {
        return (
            <PreviewError
                className="min-h-40"
                message={error || 'Your browser could not play this audio file. Download it to listen locally.'}
                onRetry={() => setRetry((r) => r + 1)}
            />
        );
    }

    if (!src) return <PreviewSkeleton label="Loading audio…" className="h-40 w-full" />;

    return (
        <div className="flex flex-col items-center gap-5 rounded-2xl border border-white/10 bg-gradient-to-br from-pink-500/10 via-transparent to-primary/10 p-6 sm:p-8">
            <span className="grid h-16 w-16 place-items-center rounded-2xl border border-pink-400/20 bg-pink-500/10 text-pink-300" aria-hidden="true">
                <Music className="h-8 w-8" />
            </span>
            <audio
                key={retry}
                src={src}
                controls
                preload="metadata"
                aria-label={title}
                onError={() => setMediaError(retry)}
                className="w-full max-w-xl"
            />
        </div>
    );
}
