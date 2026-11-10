'use client';

import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import { 
  ArrowLeft, 
  Inbox, 
  Download, 
  FileText, 
  Copy, 
  Check, 
  ExternalLink, 
  User, 
  Mail, 
  MessageSquare, 
  Loader2, 
  AlertCircle,
  FolderDown,
  ShieldCheck
} from 'lucide-react';

interface FileRequest {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  upload_count: number;
  total_bytes: number;
  is_active: number;
  created_at: number;
}

interface RequestUpload {
  id: string;
  file_id: string;
  uploader_name: string | null;
  uploader_email: string | null;
  uploader_note: string | null;
  status: string;
  uploaded_at: number;
  original_name?: string;
  file_size?: number;
  mime_type?: string;
  is_encrypted?: number;
}

function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RequestDetailsPage() {
  const params = useParams();
  const router = useRouter();
  const id = params?.id as string;

  const [request, setRequest] = useState<FileRequest | null>(null);
  const [uploads, setUploads] = useState<RequestUpload[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadDetails() {
      try {
        const res = await fetch(`/api/requests/${id}`);
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Failed to load request details');
        }
        setRequest(data.request);
        setUploads(data.uploads || []);
      } catch (err) {
        setError((err as Error)?.message || 'An error occurred');
      } finally {
        setLoading(false);
      }
    }
    if (id) loadDetails();
  }, [id]);

  const handleCopyLink = () => {
    if (!request) return;
    const url = `${window.location.origin}/r/${request.slug}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="bg-mesh min-h-dvh flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-primary animate-spin" />
      </div>
    );
  }

  if (error || !request) {
    return (
      <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
        <Header />
        <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center py-16">
          <div className="panel p-8 text-center space-y-4">
            <AlertCircle className="w-10 h-10 text-red-400 mx-auto" />
            <h1 className="text-xl font-bold text-white">Request Not Found</h1>
            <p className="text-sm text-gray-400">{error || 'Unable to find this file request.'}</p>
            <Link href="/dashboard/requests">
              <Button variant="secondary" className="w-full">
                <ArrowLeft className="w-4 h-4 mr-1.5" />
                Back to Requests
              </Button>
            </Link>
          </div>
        </main>
        <Footer />
      </div>
    );
  }

  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 py-6">
        {/* Top Back Link */}
        <div>
          <Link
            href="/dashboard/requests"
            className="inline-flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to File Requests
          </Link>
        </div>

        {/* Request Header Card */}
        <div className="panel p-6 sm:p-8 flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-white">{request.title}</h1>
              {request.is_active === 1 ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
                  Active
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium">
                  Paused
                </span>
              )}
            </div>

            {request.description && (
              <p className="text-sm text-gray-400 max-w-2xl">{request.description}</p>
            )}

            <div className="flex items-center gap-4 text-xs text-gray-400 font-mono pt-1">
              <span>{request.upload_count} files received</span>
              <span>•</span>
              <span>{formatBytes(request.total_bytes)} total</span>
              <span>•</span>
              <span>Created {new Date(request.created_at).toLocaleDateString()}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0 self-stretch sm:self-auto justify-end">
            <button
              onClick={handleCopyLink}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-xs text-gray-300 hover:text-white transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Link Copied!' : 'Copy Request Link'}</span>
            </button>

            <Link
              href={`/r/${request.slug}`}
              target="_blank"
              className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-gray-300 hover:text-white transition-colors"
              title="Open public dropzone"
            >
              <ExternalLink className="w-4 h-4" />
            </Link>
          </div>
        </div>

        {/* Received Uploads Section */}
        <div className="panel p-6 sm:p-8 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-white/10">
            <h2 className="text-lg font-bold text-white flex items-center gap-2">
              <FolderDown className="w-5 h-5 text-primary" />
              Received Files ({uploads.length})
            </h2>
          </div>

          {uploads.length === 0 ? (
            <div className="text-center py-12 space-y-3">
              <Inbox className="w-10 h-10 text-gray-600 mx-auto" />
              <p className="text-sm text-gray-400">No files uploaded to this request yet.</p>
              <p className="text-xs text-gray-500">Share your request link with clients or partners to start collecting files.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/5">
              {uploads.map((u) => (
                <div key={u.id} className="py-4 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 hover:bg-white/5 p-3 rounded-xl transition-colors">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <FileText className="w-4 h-4 text-primary shrink-0" />
                      <span className="text-sm font-semibold text-white truncate">{u.original_name || 'Uploaded File'}</span>
                      <span className="text-xs font-mono text-gray-400">({formatBytes(u.file_size || 0)})</span>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
                      {u.uploader_name && (
                        <span className="flex items-center gap-1 text-gray-300">
                          <User className="w-3 h-3 text-gray-500" />
                          {u.uploader_name}
                        </span>
                      )}
                      {u.uploader_email && (
                        <span className="flex items-center gap-1 text-gray-300">
                          <Mail className="w-3 h-3 text-gray-500" />
                          {u.uploader_email}
                        </span>
                      )}
                      <span>Uploaded {new Date(u.uploaded_at).toLocaleString()}</span>
                    </div>

                    {u.uploader_note && (
                      <div className="flex items-start gap-1.5 text-xs text-gray-300 bg-white/5 p-2 rounded-lg mt-1 italic">
                        <MessageSquare className="w-3 h-3 text-gray-400 shrink-0 mt-0.5" />
                        <span>"{u.uploader_note}"</span>
                      </div>
                    )}
                  </div>

                  <div className="shrink-0 self-end sm:self-center">
                    <a
                      href={`/v1/${u.file_id}`}
                      target="_blank"
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 text-xs font-medium transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      Download
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
