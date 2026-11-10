'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import {
  Key,
  Plus,
  Trash2,
  Copy,
  Check,
  Terminal,
  ShieldCheck,
  AlertCircle,
  Loader2,
  X,
  Clock,
  Code2,
  Inbox,
  Palette
} from 'lucide-react';

interface ApiKeyItem {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: number | null;
  expires_at: number | null;
  created_at: number;
}

export default function ApiKeysPage() {
  const [keys, setKeys] = useState<ApiKeyItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // New Key Modal
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [creating, setCreating] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);
  const [newlyCreatedKey, setNewlyCreatedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  const fetchKeys = async () => {
    try {
      const res = await fetch('/api/auth/api-keys');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load API keys');
      setKeys(data.keys || []);
    } catch (err) {
      setError((err as Error)?.message || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKeys();
  }, []);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyName.trim()) return;
    setCreating(true);
    setModalError(null);

    try {
      const res = await fetch('/api/auth/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: keyName.trim() }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create key');

      setNewlyCreatedKey(data.apiKey);
      setKeyName('');
      await fetchKeys();
    } catch (err) {
      setModalError((err as Error)?.message || 'Failed to generate key');
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to revoke this API key? Any scripts using it will stop working.')) {
      return;
    }

    try {
      const res = await fetch(`/api/auth/api-keys?id=${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to revoke key');
      await fetchKeys();
    } catch (err) {
      alert((err as Error)?.message || 'Error revoking key');
    }
  };

  const handleCopyNewKey = async () => {
    if (!newlyCreatedKey) return;
    await navigator.clipboard.writeText(newlyCreatedKey);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
  };

  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-8 pb-12">
        {/* Navigation Tabs */}
        <div className="flex border-b border-white/10 gap-6 text-sm font-medium">
          <Link
            href="/dashboard"
            className="pb-3 text-gray-400 hover:text-white transition-colors flex items-center gap-2"
          >
            My Transfers (Sent)
          </Link>
          <Link
            href="/dashboard/requests"
            className="pb-3 text-gray-400 hover:text-white transition-colors flex items-center gap-2"
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
            className="pb-3 text-primary border-b-2 border-primary flex items-center gap-2 font-semibold"
          >
            <Key className="w-4 h-4" />
            Developer API Keys
          </Link>
        </div>

        {/* Header & Button */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-2.5">
              API Keys &amp; CLI Access
            </h1>
            <p className="mt-1 text-sm text-gray-300">
              Manage personal tokens to authenticate the Datran CLI tool, automated scripts, and CI/CD pipelines.
            </p>
          </div>

          <Button
            variant="primary"
            onClick={() => {
              setNewlyCreatedKey(null);
              setIsModalOpen(true);
            }}
          >
            <Plus className="w-4 h-4 mr-1.5" /> Generate New Key
          </Button>
        </div>

        {/* Quickstart Terminal Card */}
        <div className="panel p-5 bg-black/40 border border-white/10 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-sky-400 uppercase tracking-wider">
            <Terminal className="w-4 h-4" /> Quickstart: Terminal CLI &amp; Automated Scripts
          </div>
          <p className="text-xs text-gray-300">
            Send files directly from your terminal or shell scripts. Uploads return encrypted share links instantly.
          </p>
          <div className="bg-black/60 border border-white/5 rounded-xl p-3 font-mono text-xs text-gray-200 overflow-x-auto space-y-1">
            <p className="text-gray-500"># Authenticate the terminal tool:</p>
            <p className="text-sky-300">datran login --key dtr_live_your_api_key</p>
            <p className="text-gray-500 pt-1"># Send a file and get a link:</p>
            <p className="text-emerald-400">datran send ./release-v2.0.zip</p>
          </div>
        </div>

        {/* Keys List */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <Loader2 className="w-8 h-8 animate-spin text-primary mb-3" />
            <p className="text-sm">Loading your developer keys...</p>
          </div>
        ) : error ? (
          <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-200">
            {error}
          </div>
        ) : keys.length === 0 ? (
          <div className="panel p-12 text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center mx-auto text-gray-400">
              <Key className="w-8 h-8" />
            </div>
            <h3 className="text-lg font-bold text-white">No API Keys Generated</h3>
            <p className="text-xs text-gray-400 max-w-sm mx-auto">
              Create your first personal API key to unlock the terminal CLI tool and automated programmatic uploads.
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                setNewlyCreatedKey(null);
                setIsModalOpen(true);
              }}
            >
              <Plus className="w-4 h-4 mr-1.5" /> Generate First Key
            </Button>
          </div>
        ) : (
          <div className="panel overflow-hidden border border-white/10">
            <table className="w-full text-left text-xs">
              <thead className="bg-white/[0.02] border-b border-white/10 text-gray-400 uppercase tracking-wider font-semibold">
                <tr>
                  <th className="p-4">Name</th>
                  <th className="p-4">Key Prefix</th>
                  <th className="p-4">Created</th>
                  <th className="p-4">Last Used</th>
                  <th className="p-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {keys.map((k) => (
                  <tr key={k.id} className="hover:bg-white/[0.01] transition-colors">
                    <td className="p-4 font-semibold text-white">{k.name}</td>
                    <td className="p-4 font-mono text-gray-300">{k.key_prefix}</td>
                    <td className="p-4 text-gray-400">{new Date(k.created_at).toLocaleDateString()}</td>
                    <td className="p-4 text-gray-400">
                      {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : 'Never'}
                    </td>
                    <td className="p-4 text-right">
                      <button
                        type="button"
                        onClick={() => handleDelete(k.id)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs text-red-300 hover:text-white hover:bg-red-500/20 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Create Key Modal */}
        {isModalOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-fade-in">
            <div className="panel w-full max-w-md border border-white/10 p-6 space-y-4 shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <h3 className="text-base font-bold text-white flex items-center gap-2">
                  <Key className="w-4 h-4 text-primary" />
                  {newlyCreatedKey ? 'API Key Generated' : 'Create Developer API Key'}
                </h3>
                <button onClick={() => setIsModalOpen(false)} className="text-gray-400 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {newlyCreatedKey ? (
                <div className="space-y-4">
                  <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/25 text-xs text-amber-200">
                    ⚠️ <strong>Copy this key now!</strong> For your security, this key will never be shown again.
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                      Secret API Key
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        readOnly
                        value={newlyCreatedKey}
                        className="flex-1 bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-xs font-mono text-emerald-400 focus:outline-none"
                      />
                      <Button variant="primary" size="sm" onClick={handleCopyNewKey}>
                        {copiedKey ? <Check className="w-4 h-4 mr-1" /> : <Copy className="w-4 h-4 mr-1" />}
                        {copiedKey ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  </div>

                  <div className="pt-2 flex justify-end">
                    <Button variant="secondary" size="sm" onClick={() => setIsModalOpen(false)}>
                      Done
                    </Button>
                  </div>
                </div>
              ) : (
                <form onSubmit={handleCreate} className="space-y-4">
                  <div>
                    <label htmlFor="key_name" className="block text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1.5">
                      Friendly Key Name
                    </label>
                    <input
                      id="key_name"
                      type="text"
                      required
                      autoFocus
                      placeholder="e.g. MacBook Pro CLI or GitHub Actions"
                      value={keyName}
                      onChange={(e) => setKeyName(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60"
                    />
                    <p className="text-[11px] text-gray-500 mt-1">
                      Choose a descriptive name to remember where this key is configured.
                    </p>
                  </div>

                  {modalError && (
                    <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/25 text-xs text-red-200">
                      {modalError}
                    </div>
                  )}

                  <div className="flex justify-end gap-2 pt-2">
                    <Button type="button" variant="ghost" size="sm" onClick={() => setIsModalOpen(false)}>
                      Cancel
                    </Button>
                    <Button type="submit" variant="primary" size="sm" disabled={creating || !keyName.trim()}>
                      {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" /> : null}
                      Generate Key
                    </Button>
                  </div>
                </form>
              )}
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
