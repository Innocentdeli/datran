'use client';

import { useId, useRef, useState } from 'react';
import { UploadCloud, FolderUp } from 'lucide-react';
import { cn, formatFileSize } from '@/lib/utils';
import { buttonClasses } from '@/components/ui/Button';

export interface FileUploadZoneProps {
  /** Called with the files picked or dropped (added to the current selection by the parent). */
  onFilesSelect: (files: File[]) => void;
  disabled?: boolean;
  /** Smaller variant shown under an existing selection ("Add more files"). */
  compact?: boolean;
  /** Largest file the current plan accepts (shown as a hint). */
  maxFileBytes?: number;
}

/**
 * Drop zone + file picker. Keyboard users get a real "Choose files" button; the whole zone also accepts drops and
 * mouse clicks. Folder selection uses the non-standard `webkitdirectory` attribute (all current browsers).
 */
export default function FileUploadZone({ onFilesSelect, disabled = false, compact = false, maxFileBytes }: FileUploadZoneProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const [isDragOver, setIsDragOver] = useState(false);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    if (files.length) onFilesSelect(files);
    e.target.value = ''; // allow picking the same file again
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (disabled) return;
    const files = Array.from(e.dataTransfer.files || []);
    if (files.length) onFilesSelect(files);
  };

  return (
    <div
      onClick={(e) => {
        if (disabled || (e.target as HTMLElement).closest('button')) return;
        fileInputRef.current?.click();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragOver(false);
      }}
      onDrop={handleDrop}
      className={cn(
        'relative flex flex-col items-center justify-center rounded-2xl border-2 border-dashed text-center transition-colors',
        compact ? 'gap-3 px-4 py-5 sm:flex-row sm:justify-between sm:text-left' : 'gap-4 px-5 py-10 sm:py-14',
        disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
        isDragOver ? 'border-primary bg-primary/10' : 'border-white/15 hover:border-primary/50 hover:bg-white/[0.03]'
      )}
    >
      <input ref={fileInputRef} type="file" multiple hidden onChange={pick} disabled={disabled} tabIndex={-1} />
      <input
        ref={(el) => {
          folderInputRef.current = el;
          if (el) el.setAttribute('webkitdirectory', '');
        }}
        type="file"
        hidden
        onChange={pick}
        disabled={disabled}
        tabIndex={-1}
      />

      {compact ? (
        <>
          <p className="text-sm text-gray-300">
            <span className="hidden sm:inline">Drop more files here, or </span>add more to this transfer.
          </p>
          <button
            type="button"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className={buttonClasses('secondary', 'sm')}
          >
            <UploadCloud className="h-4 w-4" aria-hidden="true" /> Add files
          </button>
        </>
      ) : (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'grid h-16 w-16 place-items-center rounded-2xl border transition-colors',
              isDragOver ? 'border-primary bg-primary/20 text-primary' : 'border-primary/25 bg-primary/10 text-primary'
            )}
          >
            <UploadCloud className="h-8 w-8" />
          </span>
          <div>
            <p className="text-lg font-semibold text-white sm:text-xl">
              {isDragOver ? 'Drop to add files' : 'Drag & drop files here'}
            </p>
            <p id={hintId} className="mt-1 text-sm text-gray-400">
              or choose them from your device{maxFileBytes ? ` · up to ${formatFileSize(maxFileBytes)} per file` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              disabled={disabled}
              aria-describedby={hintId}
              onClick={() => fileInputRef.current?.click()}
              className={buttonClasses('primary', 'lg')}
            >
              Choose files
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => folderInputRef.current?.click()}
              className={buttonClasses('ghost', 'lg', 'px-4')}
            >
              <FolderUp className="h-4 w-4" aria-hidden="true" /> Folder
            </button>
          </div>
        </>
      )}
    </div>
  );
}
