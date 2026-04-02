'use client';

import { useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, AlertCircle, FileType } from 'lucide-react';
import { cn, formatFileSize } from '@/lib/utils';
import Button from '@/components/ui/Button';

export interface FileUploadZoneProps {
  onFilesSelect: (files: File[]) => void;
  onUploadStart: () => void;
  selectedFiles: File[];
  isProcessing: boolean;
  progress: number;
  error: string | null;
  password?: string;
  onPasswordChange: (pwd: string) => void;
  isAuthenticated?: boolean;
}

export default function FileUploadZone({
  onFilesSelect,
  onUploadStart,
  selectedFiles,
  isProcessing,
  progress,
  error,
  password,
  onPasswordChange,
  isAuthenticated = false,
}: FileUploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const handleZoneClick = (e: React.MouseEvent) => {
    if (!isProcessing) {
      // Check if Shift key is held for Folder Upload (simple toggle for power users)
      if (e.shiftKey) {
        const folderInput = document.getElementById('folder-input');
        folderInput?.click();
      } else {
        fileInputRef.current?.click();
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const filesArray = Array.from(e.target.files);
      onFilesSelect(filesArray);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    if (isProcessing) return;

    // Simple file drop
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filesArray = Array.from(e.dataTransfer.files);
      // NOTE: Real folder traversal requires getAsEntry() + recursion which is async
      // For this demo, we accept the flat file list provided by browser (folders might be empty or missing contents in simple drop)
      // Browsers handle folders differently in simple 'files' array. 
      // To strictly support deep folder structure, we'd need complex loop.
      // We will assume "Flattened" or just support top-level files for V1 polish.
      onFilesSelect(filesArray);
    }
  };

  const totalSize = selectedFiles.reduce((acc, file) => acc + file.size, 0);

  return (
    <motion.div
      layout
      onClick={handleZoneClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'glass p-8 sm:p-12 flex flex-col items-center justify-center text-center border-dashed border-2 transition-all duration-300 overflow-hidden relative group min-h-[400px]',
        isProcessing
          ? 'border-primary shadow-[0_0_50px_rgba(0,242,255,0.2)] cursor-wait'
          : isDragOver
            ? 'border-primary bg-primary/10 scale-[1.02]'
            : 'border-primary/30 glow-primary cursor-pointer hover:bg-white/5',
        error && 'border-red-500/50'
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
        disabled={isProcessing}
      />
      {/* Folder Input */}
      <input
        ref={(el) => {
          // @ts-ignore
          if (el) el.webkitdirectory = true;
        }}
        type="file"
        className="hidden"
        id="folder-input"
        onChange={handleFileChange}
        disabled={isProcessing}
      />

      {/* Processing Shimmer */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 bg-primary/5 pointer-events-none"
          >
            <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-primary to-transparent animate-shimmer"></div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Upload Icon */}
      <motion.div
        animate={
          isProcessing
            ? { rotate: 360, scale: [1, 1.1, 1] }
            : { scale: 1 }
        }
        transition={
          isProcessing
            ? {
              rotate: { repeat: Infinity, duration: 2, ease: 'linear' },
              scale: { repeat: Infinity, duration: 1 },
            }
            : {}
        }
        className={cn(
          'w-20 h-20 sm:w-24 sm:h-24 mb-6 sm:mb-8 rounded-full bg-primary/10 flex items-center justify-center border border-primary/20 shadow-inner transition-transform duration-300',
          !isProcessing && isDragOver && 'scale-110 bg-primary/20',
          !isProcessing && !isDragOver && 'group-hover:scale-110'
        )}
      >
        <Upload
          className={cn(
            'w-8 h-8 sm:w-10 sm:h-10 text-primary transition-opacity',
            isProcessing && 'opacity-50'
          )}
        />
      </motion.div>

      {/* Title */}
      <h2 className="text-2xl sm:text-4xl font-black mb-3 tracking-tighter uppercase italic">
        {isProcessing
          ? 'Shattering'
          : selectedFiles.length > 0
            ? `${selectedFiles.length} Payload${selectedFiles.length > 1 ? 's' : ''}`
            : isAuthenticated ? 'Warp Ingestion' : 'Standard Upload'}
      </h2>

      {/* Description */}
      <p className="text-gray-300 max-w-sm text-xs sm:text-sm leading-relaxed tracking-wide mb-2 line-clamp-2">
        {isProcessing
          ? `Processing batch at ${isAuthenticated ? 'ultra-low Warp latency' : 'standard speed'}.`
          : selectedFiles.length > 0
            ? selectedFiles.length === 1
              ? selectedFiles[0].name
              : `${selectedFiles.map(f => f.name).join(', ')}`
            : isAuthenticated 
              ? 'Multi-path 360-degree hydration active. Select files for high-speed delivery.' 
              : 'Sign in to unlock Warp Factor acceleration and link-free neural sharing.'}
      </p>

      {/* File Size */}
      {selectedFiles.length > 0 && !isProcessing && (
        <p className="text-primary font-bold text-xs font-mono">
          Total Size: {formatFileSize(totalSize)}
        </p>
      )}

      {/* Progress Bar */}
      {isProcessing && progress > 0 && (
        <div className="w-full max-w-xs mt-6">
          <div className="h-1 bg-white/10 rounded-full overflow-hidden">
            <motion.div
              className="h-full bg-primary"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ duration: 0.3 }}
            />
          </div>
          <p className="text-xs text-primary/70 mt-2 font-mono">{progress}%</p>
        </div>
      )}

      {/* Error Message */}
      {error && (
        <div className="mt-4 flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4" />
          <span>{error}</span>
        </div>
      )}

      {/* Password Protection */}
      {!isProcessing && selectedFiles.length > 0 && (
        <div className="mt-6 w-full max-w-xs relative group/input">
          <input
            type="password"
            placeholder="Set Access Password (Optional)"
            value={password || ''}
            onChange={(e) => onPasswordChange(e.target.value)}
            className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:border-primary/50 transition-colors"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 text-white/20">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
          </div>
        </div>
      )}

      {/* Action Button */}
      <Button
        disabled={selectedFiles.length === 0 || isProcessing}
        onClick={(e) => {
          e.stopPropagation();
          onUploadStart();
        }}
        variant="primary"
        size="lg"
        className="mt-8 sm:mt-10 relative z-20"
      >
        {isProcessing ? 'Transferring...' : 'Start Transfer'}
      </Button>
    </motion.div>
  );
}
