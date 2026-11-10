'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import { 
  Inbox, 
  Plus, 
  Copy, 
  Check, 
  ExternalLink, 
  Clock, 
  FolderDown, 
  Trash2, 
  Pause, 
  Play, 
  Loader2, 
  X, 
  FileText, 
  ShieldCheck,
  AlertCircle,
  Palette,
  Key
} from 'lucide-react';

interface FileRequestItem {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  max_file_size: number | null;
  expires_at: number | null;
  is_active: number;
  upload_count: number;
  total_bytes: number;
  created_at: number;
}

function formatBytes(b: number): string {
  if (!b) return '0 B';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

export default function FileRequestsDashboard() {
  const [requests, setRequests] = useState<FileRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // Modal State
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    title: '',
    slug: '',
    description: '',
    maxFileSizeMb: '',
    expiresInDays: '7',
  });

  const fetchRequests = async () => {
    try {
      const res = await fetch('/api/requests');
      if (res.ok) {
        const json = await res.json();
        setRequests(json.requests || []);
      }
    } catch (err) {
      console.error('Failed to load requests:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, []);

  const handleCopyLink = (slug: string) => {
    const url = `${window.location.origin}/r/${slug}`;
    navigator.clipboard.writeText(url);
    setCopiedSlug(slug);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const handleToggleActive = async (id: string, currentActive: number) => {
    try {
      const res = await fetch(`/api/requests/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive: currentActive !== 1 }),
      });
      if (res.ok) {
        setRequests(prev => prev.map(r => r.id === id ? { ...r, is_active: currentActive === 1 ? 0 : 1 } : r));
      }
    } catch (err) {
      console.error('Failed to toggle request status:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this file request? Client upload links will be permanently disabled.')) {
      return;
    }
    try {
      const res = await fetch(`/api/requests/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setRequests(prev => prev.filter(r => r.id !== id));
      }
    } catch (err) {
      console.error('Failed to delete request:', err);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setFormError(null);

    const maxBytes = formData.maxFileSizeMb ? Number(formData.maxFileSizeMb) * 1024 * 1024 : undefined;
    const expiryHours = formData.expiresInDays === 'never' ? undefined : Number(formData.expiresInDays) * 24;

    try {
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: formData.title,
          slug: formData.slug || undefined,
          description: formData.description || undefined,
          maxFileSize: maxBytes,
          expiresInHours: expiryHours,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Failed to create request');
      }

      setIsModalOpen(false);
      setFormData({
        title: '',
        slug: '',
        description: '',
        maxFileSizeMb: '',
        expiresInDays: '7',
      });
      await fetchRequests();
    } catch (err) {
      setFormError((err as Error)?.message || 'An unexpected error occurred');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 py-4">
        {/* Navigation Tabs */}
        <div className="flex border-b border-white/10 gap-6 text-sm font-medium">
          <Link
            href="/dashboard"
            className="pb-3 text-gray-400 hover:text-white transition-colors"
          >
            My Transfers (Sent)
          </Link>
          <Link
            href="/dashboard/requests"
            className="pb-3 text-primary border-b-2 border-primary flex items-center gap-2 font-semibold"
          >
            <Inbox className="w-4 h-4" />
            File Requests (Received)
          </Link>
          <Link
            href="/dashboard/branding"
            className="pb-3 text-gray-400 hover:text-white transition-colors flex items-center gap-2"
          >
            <Palette className="w-4 h-4" />
            Branding &amp; Domain (Pro)
          </Link>
          <Link
            href="/dashboard/api-keys"
            className="pb-3 text-gray-400 hover:text-white transition-colors flex items-center gap-2"
          >
            <Key className="w-4 h-4" />
            Developer API Keys
          </Link>
        </div>

        {/* Header & New Request Button */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white flex items-center gap-2.5">
              File Requests
            </h1>
            <p className="mt-1 text-sm text-gray-300">
              Create links to collect files securely from clients or colleagues without email attachment limits.
            </p>
          </div>

          <Button
            variant="primary"
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New File Request
          </Button>
        </div>

        {/* Requests List */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 text-primary animate-spin" />
          </div>
        ) : requests.length === 0 ? (
          <div className="panel flex flex-col items-center justify-center py-20 px-6 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
              <Inbox className="w-8 h-8" />
            </div>
            <div className="space-y-1">
              <h2 className="text-xl font-bold text-white">No file requests created yet</h2>
              <p className="text-sm text-gray-400 max-w-md">
                Create your first request link. Clients can upload directly to your account without needing to sign up.
              </p>
            </div>
            <Button
              variant="primary"
              onClick={() => setIsModalOpen(true)}
              className="mt-2"
            >
              <Plus className="w-4 h-4 mr-1.5" />
              Create Request Link
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {requests.map((req) => (
              <div
                key={req.id}
                className="panel p-6 flex flex-col md:flex-row md:items-center justify-between gap-6 hover:border-white/20 transition-colors"
              >
                <div className="space-y-2 flex-1 min-w-0">
                  <div className="flex items-center gap-2.5 flex-wrap">
                    <h2 className="text-base sm:text-lg font-bold text-white truncate">{req.title}</h2>
                    {req.is_active === 1 ? (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Active
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs font-medium">
                        Paused
                      </span>
                    )}
                  </div>

                  {req.description && (
                    <p className="text-xs text-gray-400 line-clamp-1">{req.description}</p>
                  )}

                  <div className="flex flex-wrap items-center gap-4 text-xs text-gray-400 font-mono">
                    <span className="flex items-center gap-1 text-primary">
                      <FolderDown className="w-3.5 h-3.5" />
                      {req.upload_count} file{req.upload_count === 1 ? '' : 's'} ({formatBytes(req.total_bytes)})
                    </span>
                    <span>•</span>
                    <span>Created {new Date(req.created_at).toLocaleDateString()}</span>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                  {/* Copy Link Button */}
                  <button
                    onClick={() => handleCopyLink(req.slug)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-xs text-gray-300 hover:text-white transition-colors"
                    title="Copy request URL"
                  >
                    {copiedSlug === req.slug ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedSlug === req.slug ? 'Copied' : `/r/${req.slug}`}</span>
                  </button>

                  {/* Public Link */}
                  <Link
                    href={`/r/${req.slug}`}
                    target="_blank"
                    className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-gray-300 hover:text-white transition-colors"
                    title="Open public dropzone"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </Link>

                  {/* View Uploads Link */}
                  <Link href={`/dashboard/requests/${req.id}`}>
                    <Button variant="secondary" size="sm" className="text-xs">
                      View Files ({req.upload_count})
                    </Button>
                  </Link>

                  {/* Pause / Resume */}
                  <button
                    onClick={() => handleToggleActive(req.id, req.is_active)}
                    className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                    title={req.is_active === 1 ? 'Pause submissions' : 'Resume submissions'}
                  >
                    {req.is_active === 1 ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 text-emerald-400" />}
                  </button>

                  {/* Delete */}
                  <button
                    onClick={() => handleDelete(req.id)}
                    className="p-2 rounded-xl bg-white/5 border border-white/10 hover:bg-red-500/20 text-gray-400 hover:text-red-400 transition-colors"
                    title="Delete request"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Modal: Create File Request */}
        {isModalOpen && (
          <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="panel max-w-lg w-full p-6 sm:p-8 space-y-6 relative border border-white/15 animate-in fade-in zoom-in-95 duration-200">
              <div className="flex items-center justify-between pb-3 border-b border-white/10">
                <div className="flex items-center gap-2 text-white font-bold text-lg">
                  <Inbox className="w-5 h-5 text-primary" />
                  Create File Request
                </div>
                <button
                  onClick={() => setIsModalOpen(false)}
                  className="p-1 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <form onSubmit={handleCreate} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-300 uppercase tracking-wider mb-1.5">
                    Request Title *
                  </label>
                  <input
                    required
                    type="text"
                    placeholder="e.g. Tax Returns & Receipts 2026"
                    value={formData.title}
                    onChange={(e) => setFormData(p => ({ ...p, title: e.target.value }))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-300 uppercase tracking-wider mb-1.5">
                    Custom Link Slug (Optional)
                  </label>
                  <div className="flex items-center bg-white/5 border border-white/10 rounded-xl overflow-hidden focus-within:border-primary/60 transition-colors">
                    <span className="px-3 text-xs text-gray-500 font-mono">datran.app/r/</span>
                    <input
                      type="text"
                      placeholder="tax-returns-2026"
                      value={formData.slug}
                      onChange={(e) => setFormData(p => ({ ...p, slug: e.target.value }))}
                      className="w-full bg-transparent py-2.5 pr-4 text-sm text-white focus:outline-none placeholder:text-gray-600"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-gray-300 uppercase tracking-wider mb-1.5">
                    Instructions for Clients (Optional)
                  </label>
                  <textarea
                    rows={2}
                    placeholder="e.g. Please drop your signed contract and invoices in PDF or ZIP format."
                    value={formData.description}
                    onChange={(e) => setFormData(p => ({ ...p, description: e.target.value }))}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500 resize-none"
                  />
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-gray-300 uppercase tracking-wider mb-1.5">
                      Max File Size (MB)
                    </label>
                    <input
                      type="number"
                      placeholder="No limit"
                      value={formData.maxFileSizeMb}
                      onChange={(e) => setFormData(p => ({ ...p, maxFileSizeMb: e.target.value }))}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors placeholder:text-gray-500"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-gray-300 uppercase tracking-wider mb-1.5">
                      Link Expiry
                    </label>
                    <select
                      value={formData.expiresInDays}
                      onChange={(e) => setFormData(p => ({ ...p, expiresInDays: e.target.value }))}
                      className="w-full bg-[#0d1424] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors"
                    >
                      <option value="1">24 Hours</option>
                      <option value="7">7 Days</option>
                      <option value="30">30 Days</option>
                      <option value="never">Never (Until paused)</option>
                    </select>
                  </div>
                </div>

                {formError && (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-200">
                    <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                    <span>{formError}</span>
                  </div>
                )}

                <div className="flex items-center justify-end gap-3 pt-3 border-t border-white/10">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setIsModalOpen(false)}
                    disabled={creating}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={creating || !formData.title.trim()}
                  >
                    {creating ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : null}
                    Create Request Link
                  </Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
