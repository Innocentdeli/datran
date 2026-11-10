'use client';

import { useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Mail, ShieldCheck, Download, ExternalLink } from 'lucide-react';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import { formatFileSize, formatTimestamp } from '@/lib/utils';
import DeliveryTrackerModal from './DeliveryTrackerModal';
import type { FileRecord } from '@/db/files';

interface DashboardFileCardProps {
  file: FileRecord;
  tag: string | null;
}

export default function DashboardFileCard({ file, tag }: DashboardFileCardProps) {
  const [showTracker, setShowTracker] = useState(false);

  return (
    <>
      <div className="group panel relative p-5 flex flex-col gap-4 transition-colors hover:border-primary/40">
        <Link href={`/v1/${file.share_id}`} className="flex items-center gap-4">
          <div className="w-14 h-14 rounded-xl bg-black/40 border border-white/10 overflow-hidden flex-shrink-0 relative">
            {file.thumbnail_path ? (
              <Image
                src={`/api/thumbnail/${file.share_id}`}
                alt=""
                fill
                sizes="56px"
                unoptimized
                className="object-cover"
              />
            ) : (
              <FileTypeIcon name={file.original_name} className="h-full w-full rounded-none border-0" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h2 className="font-semibold text-white group-hover:text-primary transition-colors truncate" title={file.original_name}>
              {file.original_name}
            </h2>
            <div className="flex items-center gap-2 mt-1.5">
              <span className="text-xs text-gray-300">
                {formatFileSize(file.file_size)}
              </span>
              {tag && (
                <span className="text-xs text-primary">
                  #{tag}
                </span>
              )}
            </div>
          </div>
        </Link>

        {file.summary && (
          <p className="text-sm text-gray-300 line-clamp-2 leading-relaxed">
            {file.summary}
          </p>
        )}

        <div className="flex items-center justify-between text-xs mt-auto pt-4 border-t border-white/[0.06]">
          <div className="flex flex-col gap-0.5">
            <span className="text-gray-400">Uploaded</span>
            <span className="text-gray-200">{formatTimestamp(new Date(file.created_at))}</span>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowTracker(true)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white/5 border border-white/10 text-gray-300 hover:text-white hover:bg-white/10 hover:border-primary/40 transition-colors text-xs font-medium"
              title="Delivery Tracking and Email Dispatch"
            >
              <Mail className="w-3.5 h-3.5 text-sky-400" />
              <span>Track &amp; Send</span>
            </button>

            <div className="flex flex-col gap-0.5 text-right">
              <span className="text-gray-400">Downloads</span>
              <span className="text-gray-200">{file.downloads}</span>
            </div>
          </div>
        </div>
      </div>

      {showTracker && (
        <DeliveryTrackerModal
          fileId={file.share_id}
          fileName={file.original_name}
          isOpen={showTracker}
          onClose={() => setShowTracker(false)}
        />
      )}
    </>
  );
}
