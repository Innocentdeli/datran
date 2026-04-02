'use client';

import { motion } from 'framer-motion';
import { Download, ExternalLink, FileText } from 'lucide-react';
import Button from '@/components/ui/Button';

interface PDFViewerProps {
    fileId: string;
    metadata?: any;
}

export default function PDFViewer({ fileId, metadata }: PDFViewerProps) {
    const title = metadata?.original_name || decodeURIComponent(fileId).replace(/\.(omni|reactor)\.acs$/, '');
    const streamUrl = `/api/stream?file=${encodeURIComponent(fileId)}`;

    return (
        <div className="flex flex-col h-[85vh] w-full bg-black/40 rounded-[28px] overflow-hidden border border-white/5 shadow-2xl backdrop-blur-xl">
            {/* PDF Header / Controls */}
            <div className="flex items-center justify-between px-6 py-4 bg-white/5 border-b border-white/10 shrink-0">
                <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center">
                        <FileText className="w-4 h-4 text-red-500" />
                    </div>
                    <span className="text-xs font-mono text-gray-400 uppercase tracking-widest truncate max-w-[200px]">
                        {title}
                    </span>
                </div>

                <div className="flex items-center gap-2">
                    <a href={streamUrl} download target="_blank">
                        <Button variant="secondary" size="sm" className="gap-2 h-9">
                            <Download className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">Download</span>
                        </Button>
                    </a>
                    <a href={streamUrl} target="_blank">
                        <Button variant="ghost" size="sm" className="h-9 w-9 p-0">
                            <ExternalLink className="w-4 h-4" />
                        </Button>
                    </a>
                </div>
            </div>

            {/* PDF Container */}
            <div className="flex-1 bg-[#1a1a1a] relative group overflow-hidden">
                <iframe
                    src={`${streamUrl}#navpanes=0`}
                    className="w-full h-full border-none"
                    title="PDF Content"
                />

                {/* Overlay to catch clicks if needed or styling */}
                <div className="absolute inset-0 pointer-events-none border border-white/5 rounded-b-[28px]" />
            </div>

            <div className="px-6 py-3 bg-white/5 border-t border-white/10 flex justify-center">
                <p className="text-[10px] font-mono text-gray-600 uppercase tracking-[0.2em]">
                    Diocom Neural Projection System // Document Mode
                </p>
            </div>
        </div>
    );
}
