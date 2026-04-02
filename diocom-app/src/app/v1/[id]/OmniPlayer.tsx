'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { detectFileType, FileType } from '@/lib/fileUtils';
import { config } from '@/config';
import VideoPlayer from './VideoPlayer';
import AudioPlayer from '@/components/viewers/AudioPlayer';
import ImageViewer from '@/components/viewers/ImageViewer';
import PDFViewer from '@/components/viewers/PDFViewer';
import DownloadViewer from '@/components/viewers/DownloadViewer';

interface OmniPlayerProps {
  fileId: string;
  metadata?: any;
}

export default function OmniPlayer({ fileId, metadata }: OmniPlayerProps) {
  const [fileType, setFileType] = useState<FileType | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(true);

  useEffect(() => {
    // Detect file type from ID
    const cleanId = decodeURIComponent(fileId).replace(/\.(omni|reactor)\.acs$/, '');
    const detectedType = detectFileType(cleanId);

    // Quick analysis (configurable delay for smooth transition)
    setTimeout(() => {
      setFileType(detectedType);
      setIsAnalyzing(false);
    }, config.ui.analysisDelay);
  }, [fileId]);

  if (isAnalyzing || !fileType) {
    return (
      <div className="relative aspect-video bg-gradient-to-br from-gray-900 to-black flex flex-col items-center justify-center rounded-[28px] sm:rounded-[36px]">
        <Loader2 className="w-12 h-12 text-primary animate-spin mb-4" />
        <p className="text-[10px] font-mono text-primary animate-pulse tracking-[0.2em] uppercase">
          Protecting Transfer Link... Analyzing File
        </p>
      </div>
    );
  }

  // Route to appropriate viewer based on file type
  switch (fileType) {
    case 'video':
      return <VideoPlayer fileId={fileId} metadata={metadata} />;

    case 'audio':
      return (
        <div className="bg-gradient-to-br from-gray-900 to-black rounded-[28px] sm:rounded-[36px]">
          <AudioPlayer fileId={fileId} metadata={metadata} />
        </div>
      );

    case 'image':
      return (
        <div className="bg-gradient-to-br from-gray-900 to-black rounded-[28px] sm:rounded-[36px] p-8">
          <ImageViewer fileId={fileId} metadata={metadata} />
        </div>
      );

    case 'pdf':
      return <PDFViewer fileId={fileId} metadata={metadata} />;

    case 'document':
    case 'archive':
    case 'code':
    case 'unknown':
      return (
        <div className="bg-gradient-to-br from-gray-900 to-black rounded-[28px] sm:rounded-[36px]">
          <DownloadViewer fileId={fileId} fileType={fileType} metadata={metadata} />
        </div>
      );

    default:
      return (
        <div className="bg-gradient-to-br from-gray-900 to-black rounded-[28px] sm:rounded-[36px]">
          <DownloadViewer fileId={fileId} fileType="unknown" />
        </div>
      );
  }
}
