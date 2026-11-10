'use client';

import { useState, useEffect, useRef } from 'react';
import { useParams } from 'next/navigation';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import { 
  Upload, 
  ShieldCheck, 
  CheckCircle2, 
  Lock, 
  FileText, 
  AlertCircle, 
  Loader2, 
  Inbox,
  User,
  Mail,
  MessageSquare
} from 'lucide-react';

interface RequestMeta {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  requester_name: string;
  max_file_size: number | null;
  is_active: number;
  has_password: boolean;
  expires_at: number | null;
  is_expired: boolean;
  brand?: {
    brand_name: string | null;
    brand_logo_url: string | null;
    brand_color: string | null;
    brand_wallpaper_url: string | null;
    brand_tagline: string | null;
  } | null;
}

interface UploadedItem {
  name: string;
  size: number;
  shareId: string;
}

function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export default function PublicFileRequestPage() {
  const params = useParams();
  const slug = params?.slug as string;

  const [meta, setMeta] = useState<RequestMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [uploaderName, setUploaderName] = useState('');
  const [uploaderEmail, setUploaderEmail] = useState('');
  const [uploaderNote, setUploaderNote] = useState('');

  // Drag & Upload State
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [currentFileText, setCurrentFileText] = useState('');
  const [completedItems, setCompletedItems] = useState<UploadedItem[]>([]);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    async function loadRequest() {
      try {
        const res = await fetch(`/api/requests/public/${slug}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'File request not found');
        }
        setMeta(data.request);
      } catch (err) {
        setError((err as Error)?.message || 'Failed to load file request');
      } finally {
        setLoading(false);
      }
    }
    if (slug) loadRequest();
  }, [slug]);

  const handleFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    if (!files.length) return;

    // Check size limit if configured
    if (meta?.max_file_size) {
      for (const f of files) {
        if (f.size > meta.max_file_size) {
          setUploadError(`File "${f.name}" exceeds maximum allowed size of ${formatBytes(meta.max_file_size)}.`);
          return;
        }
      }
    }

    setUploading(true);
    setUploadError(null);
    const uploadedList: UploadedItem[] = [];

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setCurrentFileText(`Uploading ${file.name} (${i + 1}/${files.length})...`);

        const formData = new FormData();
        formData.append('file', file);
        formData.append('isEncrypted', '0'); // unencrypted direct deposit to requester inbox

        const ingestRes = await fetch('/api/ingest', {
          method: 'POST',
          body: formData,
        });

        if (!ingestRes.ok) {
          const errData = await ingestRes.json().catch(() => ({}));
          throw new Error(errData.message || `Failed to upload ${file.name}`);
        }

        const ingestData = await ingestRes.json();
        let shareId = ingestData.shareId;
        if (!shareId && ingestData.link) {
          const match = ingestData.link.match(/\/v1\/([^/?#]+)/);
          if (match) shareId = match[1];
        }

        if (!shareId) {
          throw new Error(`Upload succeeded but received invalid file ID for ${file.name}`);
        }

        // Attach to file request
        const attachRes = await fetch(`/api/requests/public/${slug}/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileId: shareId,
            fileSize: file.size,
            uploaderName,
            uploaderEmail,
            uploaderNote,
          }),
        });

        if (!attachRes.ok) {
          const attachData = await attachRes.json().catch(() => ({}));
          throw new Error(attachData.error || `Failed to link ${file.name} to request`);
        }

        uploadedList.push({
          name: file.name,
          size: file.size,
          shareId,
        });
      }

      setCompletedItems(prev => [...prev, ...uploadedList]);
      setUploadSuccess(true);
    } catch (err) {
      setUploadError((err as Error)?.message || 'An error occurred during upload.');
    } finally {
      setUploading(false);
      setIsDragging(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  if (loading) {
    return (
      <div className="bg-mesh min-h-dvh flex flex-col justify-center items-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (error || !meta) {
    return (
      <div className="bg-mesh min-h-dvh flex flex-col px-4 pt-4 sm:px-8 sm:pt-6">
        <Header />
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center py-16">
          <div className="panel p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/25 flex items-center justify-center mx-auto text-red-400">
              <AlertCircle className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold text-white">File Request Unavailable</h1>
            <p className="text-sm text-gray-400">{error || 'This link may have been paused, deleted, or does not exist.'}</p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  if (!meta.is_active || meta.is_expired) {
    return (
      <div className="bg-mesh min-h-dvh flex flex-col px-4 pt-4 sm:px-8 sm:pt-6">
        <Header />
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center py-16">
          <div className="panel p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/25 flex items-center justify-center mx-auto text-amber-400">
              <Lock className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold text-white">
              {meta.is_expired ? 'Request Expired' : 'Request Paused'}
            </h1>
            <p className="text-sm text-gray-400">
              {meta.is_expired 
                ? 'This file request link has reached its designated expiration date and is no longer accepting submissions.'
                : 'The owner of this request has temporarily closed or paused submissions.'}
            </p>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div
      className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6 relative"
      style={meta?.brand?.brand_color ? ({ '--primary': meta.brand.brand_color } as React.CSSProperties) : undefined}
    >
      {meta?.brand?.brand_wallpaper_url && (
        <div
          className="absolute inset-0 bg-cover bg-center pointer-events-none opacity-20 transition-opacity"
          style={{ backgroundImage: `url(${meta.brand.brand_wallpaper_url})` }}
        />
      )}

      <div className="relative z-10">
        <Header />
      </div>

      <main className="relative z-10 mx-auto w-full max-w-2xl flex-1 py-12">
        {/* Header Request Card */}
        <div className="panel p-6 sm:p-10 mb-6 relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
          
          {meta.brand?.brand_logo_url && (
            <div className="mb-5">
              <img
                src={meta.brand.brand_logo_url}
                alt={meta.brand.brand_name || 'Brand Logo'}
                className="h-9 w-auto max-w-[180px] object-contain rounded"
              />
            </div>
          )}

          <div className="flex items-center gap-2 mb-3">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/25 text-primary text-xs font-mono">
              <Inbox className="w-3.5 h-3.5" />
              Secure File Request
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs">
              <ShieldCheck className="w-3 h-3" />
              Direct Encrypted Egress
            </span>
          </div>

          <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight mb-2">
            {meta.title}
          </h1>

          <p className="text-sm text-gray-300 leading-relaxed mb-4">
            {meta.description || `Send files directly to ${meta.brand?.brand_name || meta.requester_name}. Your files will be securely deposited with end-to-end encryption.`}
          </p>

          <div className="flex flex-wrap gap-4 text-xs text-gray-400 border-t border-white/10 pt-4">
            <div>
              <span className="text-gray-500">Recipient:</span> <strong className="text-white">{meta.requester_name}</strong>
            </div>
            {meta.max_file_size && (
              <div>
                <span className="text-gray-500">Max size per file:</span> <strong className="text-white">{formatBytes(meta.max_file_size)}</strong>
              </div>
            )}
          </div>
        </div>

        {/* Upload Success Screen */}
        {uploadSuccess ? (
          <div className="panel p-8 text-center space-y-6 animate-in fade-in zoom-in-95 duration-200">
            <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 mx-auto">
              <CheckCircle2 className="w-8 h-8" />
            </div>

            <div className="space-y-1">
              <h2 className="text-xl font-bold text-white">Files Delivered Successfully</h2>
              <p className="text-sm text-gray-400">
                Your files have been safely uploaded and linked to <strong>{meta.requester_name}</strong>'s request.
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-white/5 divide-y divide-white/5 text-left text-xs">
              {completedItems.map((item, idx) => (
                <div key={idx} className="flex items-center justify-between p-3">
                  <div className="flex items-center gap-2 truncate">
                    <FileText className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-white font-medium truncate">{item.name}</span>
                  </div>
                  <span className="text-gray-400 font-mono shrink-0 ml-3">{formatBytes(item.size)}</span>
                </div>
              ))}
            </div>

            <Button
              variant="secondary"
              onClick={() => {
                setUploadSuccess(false);
                setCompletedItems([]);
              }}
              className="w-full sm:w-auto"
            >
              Send More Files
            </Button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Optional Uploader Details Form */}
            <div className="panel p-6 space-y-4">
              <h3 className="text-sm font-semibold text-white">Your Information (Optional)</h3>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="relative">
                  <label htmlFor="uploader-name" className="sr-only">Your Name</label>
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    id="uploader-name"
                    type="text"
                    placeholder="Your Name (optional)"
                    value={uploaderName}
                    onChange={(e) => setUploaderName(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-xs sm:text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500"
                  />
                </div>

                <div className="relative">
                  <label htmlFor="uploader-email" className="sr-only">Your Email</label>
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    id="uploader-email"
                    type="email"
                    placeholder="Your Email (optional)"
                    value={uploaderEmail}
                    onChange={(e) => setUploaderEmail(e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-xs sm:text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500"
                  />
                </div>
              </div>

              <div className="relative">
                <label htmlFor="uploader-note" className="sr-only">Note or Message</label>
                <MessageSquare className="absolute left-3.5 top-3.5 w-4 h-4 text-gray-400" />
                <textarea
                  id="uploader-note"
                  rows={2}
                  placeholder="Add a message or note for the recipient..."
                  value={uploaderNote}
                  onChange={(e) => setUploaderNote(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-xl py-2.5 pl-10 pr-4 text-xs sm:text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 resize-none"
                />
              </div>
            </div>

            {/* Hidden Input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) handleFiles(e.target.files);
              }}
            />

            {/* Drop Zone */}
            <div
              onClick={() => !uploading && fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
              }}
              className={`panel p-10 border-2 border-dashed transition-all cursor-pointer text-center relative group ${
                isDragging ? 'border-primary bg-primary/10' : 'border-white/15 hover:border-primary/50'
              }`}
            >
              <div className="flex flex-col items-center justify-center gap-3">
                {uploading ? (
                  <>
                    <Loader2 className="w-10 h-10 text-primary animate-spin" />
                    <p className="text-sm font-medium text-white">{currentFileText}</p>
                    <p className="text-xs text-gray-500">Transmitting bytes to secure recipient inbox</p>
                  </>
                ) : (
                  <>
                    <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center group-hover:scale-105 transition-transform">
                      <Upload className="w-7 h-7 text-primary" />
                    </div>
                    <div>
                      <p className="text-base font-semibold text-white">
                        {isDragging ? 'Drop files to upload now' : 'Drag & drop files here, or click to browse'}
                      </p>
                      <p className="text-xs text-gray-400 mt-1">
                        Files are sent securely with zero-knowledge encryption
                      </p>
                    </div>
                  </>
                )}
              </div>
            </div>

            {uploadError && (
              <div className="flex items-center gap-2 p-3.5 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-200">
                <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                <span>{uploadError}</span>
              </div>
            )}
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
