'use client';

import { useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PublicFile } from '@/db/files';
import { useE2ESource } from './useE2ESource';
import { PreviewError, PreviewSkeleton } from './PreviewState';

interface ImageViewerProps {
    fileId: string;
    metadata?: PublicFile;
}

export default function ImageViewer({ fileId, metadata }: ImageViewerProps) {
    const [retry, setRetry] = useState(0);
    // Load state is keyed by the attempt so a retry starts from "loading" again.
    const [loaded, setLoaded] = useState<number | null>(null);
    const [failed, setFailed] = useState<number | null>(null);
    const [fullSize, setFullSize] = useState(false);
    const { src, error } = useE2ESource(fileId, metadata, retry);
    const name = metadata?.original_name || 'Shared image';
    const isLoaded = loaded === retry;
    const hasError = !!error || failed === retry;

    if (hasError) {
        return (
            <PreviewError
                className="min-h-64"
                message={error || 'The image could not be displayed. If this is an encrypted file, make sure you opened the complete link including the part after “#”.'}
                onRetry={() => setRetry((r) => r + 1)}
            />
        );
    }

    return (
        <figure className="relative">
            {!isLoaded && <PreviewSkeleton label="Loading image…" className="aspect-[4/3] w-full sm:aspect-video" />}
            {src && (
                <div className={cn('overflow-auto rounded-2xl bg-black/40', !isLoaded && 'sr-only', fullSize ? 'max-h-[80vh]' : '')}>
                    {/* A decrypted blob/stream URL: next/image optimisation can't apply, so a plain <img> is used. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                        key={retry}
                        src={src}
                        alt={name}
                        decoding="async"
                        onLoad={() => setLoaded(retry)}
                        onError={() => setFailed(retry)}
                        className={cn('mx-auto block', fullSize ? 'max-w-none' : 'max-h-[70vh] w-auto max-w-full object-contain')}
                    />
                </div>
            )}
            {isLoaded && (
                <figcaption className="mt-2 flex justify-end">
                    <button
                        type="button"
                        onClick={() => setFullSize((v) => !v)}
                        aria-pressed={fullSize}
                        className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-gray-300 hover:bg-white/5 hover:text-white"
                    >
                        {fullSize ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
                        {fullSize ? 'Fit to screen' : 'Actual size'}
                    </button>
                </figcaption>
            )}
        </figure>
    );
}
