'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { ZoomIn, ZoomOut, AlertCircle, Download } from 'lucide-react';
import { cn } from '@/lib/utils';
import Button from '@/components/ui/Button';
import type { PublicFile } from '@/db/files';
import { useE2ESource } from './useE2ESource';

interface ImageViewerProps {
    fileId: string;
    metadata?: PublicFile;
}

export default function ImageViewer({ fileId, metadata }: ImageViewerProps) {
    const [zoom, setZoom] = useState(100);
    const [isLoaded, setIsLoaded] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [retryTrigger, setRetryTrigger] = useState(0);
    const { src: imageSrc, error: decryptError, download } = useE2ESource(fileId, metadata, retryTrigger);
    const hasError = loadFailed || !!decryptError;

    const handleZoomIn = () => setZoom((prev) => Math.min(prev + 25, 200));
    const handleZoomOut = () => setZoom((prev) => Math.max(prev - 25, 50));

    return (
        <div className="relative flex flex-col items-center justify-center py-8">
            {/* Image Container */}
            <div className="relative max-w-full overflow-auto rounded-lg min-h-[300px] w-full flex items-center justify-center bg-black/20">
                {!hasError && imageSrc ? (
                    <motion.img
                        src={imageSrc}
                        alt={decodeURIComponent(fileId)}
                        className={cn(
                            'max-w-full h-auto transition-opacity duration-300',
                            isLoaded ? 'opacity-100' : 'opacity-0'
                        )}
                        style={{
                            transform: `scale(${zoom / 100})`,
                            transformOrigin: 'center',
                        }}
                        onLoad={() => {
                            console.log('[VIEWER] Image loaded successfully');
                            setIsLoaded(true);
                        }}
                        onError={() => {
                            console.error('[VIEWER] Image load failed');
                            setLoadFailed(true);
                            setIsLoaded(true);
                        }}
                    />
                ) : hasError ? (
                    <div className="flex flex-col items-center justify-center p-12 text-center">
                        <AlertCircle className="w-16 h-16 text-red-500/50 mb-4" />
                        <h3 className="text-xl font-bold text-red-500 mb-2">Image could not be loaded</h3>
                        <p className="text-sm text-gray-400 max-w-xs">
                            {decryptError || 'The visual data stream could not be established. Ensure your URL includes the #key=... fragment for Zero-Knowledge decryption.'}
                        </p>
                        <Button
                            variant="primary"
                            size="md"
                            className="mt-8"
                            onClick={() => {
                                setLoadFailed(false);
                                setIsLoaded(false);
                                setRetryTrigger((prev) => prev + 1);
                            }}
                        >
                            Retry Handshake
                        </Button>
                    </div>
                ) : null}

                {!isLoaded && !hasError && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
                        <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin shadow-[0_0_15px_rgba(0,242,255,0.3)]" />
                        <span className="text-[10px] font-mono text-primary animate-pulse uppercase tracking-widest">Piping Bits...</span>
                    </div>
                )}
            </div>

            {/* Controls */}
            {isLoaded && !hasError && imageSrc && (
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-6 flex items-center gap-4 bg-black/40 backdrop-blur-md px-6 py-3 rounded-2xl border border-white/10"
                >
                    <button
                        onClick={handleZoomOut}
                        disabled={zoom <= 50}
                        className="w-10 h-10 bg-white/5 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <ZoomOut className="w-5 h-5" />
                    </button>

                    <span className="text-sm font-mono text-white/70 min-w-[64px] text-center">
                        {zoom}%
                    </span>

                    <button
                        onClick={handleZoomIn}
                        disabled={zoom >= 200}
                        className="w-10 h-10 bg-white/5 rounded-lg flex items-center justify-center hover:bg-white/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <ZoomIn className="w-5 h-5" />
                    </button>

                    <button
                        type="button"
                        onClick={() => {
                            download().catch((err: unknown) => alert(err instanceof Error ? err.message : String(err)));
                        }}
                        className="w-10 h-10 bg-primary/20 text-primary rounded-lg flex items-center justify-center hover:bg-primary/30 transition-colors"
                        title="Download Decrypted Image"
                    >
                        <Download className="w-5 h-5" />
                    </button>
                </motion.div>
            )}
        </div>
    );
}
