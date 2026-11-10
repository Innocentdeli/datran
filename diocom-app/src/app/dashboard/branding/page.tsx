'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import Button from '@/components/ui/Button';
import {
  Palette,
  Globe,
  Upload,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Eye,
  Inbox,
  ArrowRight,
  Key
} from 'lucide-react';

interface BrandData {
  brand_name: string | null;
  brand_logo_url: string | null;
  brand_color: string | null;
  brand_wallpaper_url: string | null;
  brand_tagline: string | null;
  custom_domain: string | null;
  custom_domain_status: 'pending' | 'verified' | 'failed';
}

const PRESET_COLORS = [
  { name: 'Sky Blue', hex: '#0284c7' },
  { name: 'Indigo', hex: '#6366f1' },
  { name: 'Emerald', hex: '#10b981' },
  { name: 'Violet', hex: '#8b5cf6' },
  { name: 'Rose', hex: '#f43f5e' },
  { name: 'Amber', hex: '#f59e0b' },
  { name: 'Slate Dark', hex: '#334155' },
];

const PRESET_WALLPAPERS = [
  { name: 'Deep Space', url: 'https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?auto=format&fit=crop&w=1600&q=80' },
  { name: 'Subtle Mesh', url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1600&q=80' },
  { name: 'Dark Gradient', url: 'https://images.unsplash.com/photo-1579546929518-9e396f3cc809?auto=format&fit=crop&w=1600&q=80' },
  { name: 'Minimalist Clean', url: '' },
];

export default function BrandingDashboardPage() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [form, setForm] = useState<BrandData>({
    brand_name: '',
    brand_logo_url: '',
    brand_color: '#0284c7',
    brand_wallpaper_url: '',
    brand_tagline: '',
    custom_domain: '',
    custom_domain_status: 'pending',
  });

  useEffect(() => {
    fetch('/api/branding')
      .then((res) => res.json())
      .then((data) => {
        if (data.brand) {
          setForm({
            brand_name: data.brand.brand_name || '',
            brand_logo_url: data.brand.brand_logo_url || '',
            brand_color: data.brand.brand_color || '#0284c7',
            brand_wallpaper_url: data.brand.brand_wallpaper_url || '',
            brand_tagline: data.brand.brand_tagline || '',
            custom_domain: data.brand.custom_domain || '',
            custom_domain_status: data.brand.custom_domain_status || 'pending',
          });
        }
      })
      .catch((err) => console.error('Failed to load branding:', err))
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const res = await fetch('/api/branding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save changes');

      setMessage({ type: 'success', text: 'Brand settings saved successfully!' });
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error)?.message || 'Failed to save' });
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyDomain = async () => {
    if (!form.custom_domain) return;
    setVerifying(true);
    setMessage(null);

    try {
      const res = await fetch('/api/branding/verify-domain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: form.custom_domain }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Verification failed');

      if (data.verified) {
        setForm((prev) => ({ ...prev, custom_domain_status: 'verified' }));
        setMessage({ type: 'success', text: data.message });
      } else {
        setForm((prev) => ({ ...prev, custom_domain_status: 'failed' }));
        setMessage({ type: 'error', text: data.message });
      }
    } catch (err) {
      setMessage({ type: 'error', text: (err as Error)?.message || 'Verification error' });
    } finally {
      setVerifying(false);
    }
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
            className="pb-3 text-primary border-b-2 border-primary flex items-center gap-2 font-semibold"
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

        {/* Header */}
        <div className="flex flex-col sm:flex-row items-start sm:items-baseline justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-3xl font-bold tracking-tight text-white">Brand Customization</h1>
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-amber-300 border border-amber-500/30">
                <Sparkles className="w-3 h-3 text-amber-400" /> Pro Feature
              </span>
            </div>
            <p className="mt-1 text-sm text-gray-300">
              Deliver transfers to your clients with your custom logo, brand colors, custom background, and custom CNAME domain.
            </p>
          </div>
        </div>

        {message && (
          <div
            className={`flex items-center gap-3 p-4 rounded-2xl border text-sm animate-fade-in ${
              message.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                : 'bg-red-500/10 border-red-500/30 text-red-200'
            }`}
          >
            {message.type === 'success' ? (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            ) : (
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
            )}
            <p>{message.text}</p>
          </div>
        )}

        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <Loader2 className="w-8 h-8 animate-spin text-primary mb-3" />
            <p className="text-sm">Loading your brand configuration...</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Editor Column */}
            <form onSubmit={handleSave} className="lg:col-span-7 space-y-6">
              {/* Brand Identity */}
              <div className="panel p-6 space-y-4">
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-primary" /> Company Identity
                </h2>

                <div className="space-y-1.5">
                  <label htmlFor="brand_name" className="text-xs font-semibold text-gray-300">
                    Company or Studio Name
                  </label>
                  <input
                    id="brand_name"
                    type="text"
                    placeholder="e.g. Acme Design Studio"
                    value={form.brand_name || ''}
                    onChange={(e) => setForm({ ...form, brand_name: e.target.value })}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors"
                  />
                  <p className="text-[11px] text-gray-500">
                    Replaces &quot;Datran&quot; in the header and download confirmation receipts.
                  </p>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="brand_tagline" className="text-xs font-semibold text-gray-300">
                    Portal Tagline / Subtitle
                  </label>
                  <input
                    id="brand_tagline"
                    type="text"
                    placeholder="e.g. Client Deliverables &amp; Raw Assets Portal"
                    value={form.brand_tagline || ''}
                    onChange={(e) => setForm({ ...form, brand_tagline: e.target.value })}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors"
                  />
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="brand_logo_url" className="text-xs font-semibold text-gray-300">
                    Logo Image URL
                  </label>
                  <input
                    id="brand_logo_url"
                    type="url"
                    placeholder="https://yourcompany.com/logo.png"
                    value={form.brand_logo_url || ''}
                    onChange={(e) => setForm({ ...form, brand_logo_url: e.target.value })}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors"
                  />
                  <p className="text-[11px] text-gray-500">
                    Transparent PNG or SVG with 1:1 or 4:1 aspect ratio recommended.
                  </p>
                </div>
              </div>

              {/* Theme & Background */}
              <div className="panel p-6 space-y-4">
                <h2 className="text-base font-bold text-white flex items-center gap-2">
                  <Palette className="w-4 h-4 text-primary" /> Visual Appearance
                </h2>

                <div className="space-y-2">
                  <label htmlFor="brand_color" className="text-xs font-semibold text-gray-300">
                    Accent Color
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      id="brand_color"
                      type="color"
                      value={form.brand_color || '#0284c7'}
                      onChange={(e) => setForm({ ...form, brand_color: e.target.value })}
                      className="w-10 h-10 rounded-xl border border-white/20 bg-transparent cursor-pointer overflow-hidden p-0"
                    />
                    <input
                      type="text"
                      value={form.brand_color || '#0284c7'}
                      onChange={(e) => setForm({ ...form, brand_color: e.target.value })}
                      className="w-32 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-primary/60"
                    />
                    <div className="flex flex-wrap gap-1.5 ml-auto">
                      {PRESET_COLORS.map((c) => (
                        <button
                          key={c.hex}
                          type="button"
                          onClick={() => setForm({ ...form, brand_color: c.hex })}
                          className={`w-6 h-6 rounded-full border border-white/20 transition-transform ${
                            form.brand_color === c.hex ? 'scale-125 ring-2 ring-white' : 'hover:scale-110'
                          }`}
                          style={{ backgroundColor: c.hex }}
                          title={c.name}
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="space-y-2 pt-2">
                  <label htmlFor="brand_wallpaper_url" className="text-xs font-semibold text-gray-300">
                    Custom Wallpaper / Background URL
                  </label>
                  <input
                    id="brand_wallpaper_url"
                    type="url"
                    placeholder="https://images.unsplash.com/... or custom image URL"
                    value={form.brand_wallpaper_url || ''}
                    onChange={(e) => setForm({ ...form, brand_wallpaper_url: e.target.value })}
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors"
                  />
                  <div className="flex flex-wrap gap-2 pt-1">
                    {PRESET_WALLPAPERS.map((wp) => (
                      <button
                        key={wp.name}
                        type="button"
                        onClick={() => setForm({ ...form, brand_wallpaper_url: wp.url })}
                        className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
                          form.brand_wallpaper_url === wp.url
                            ? 'bg-primary/20 border-primary text-white font-medium'
                            : 'bg-white/5 border-white/10 text-gray-400 hover:text-white'
                        }`}
                      >
                        {wp.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Custom Domain */}
              <div className="panel p-6 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-bold text-white flex items-center gap-2">
                    <Globe className="w-4 h-4 text-primary" /> Custom CNAME Domain
                  </h2>
                  {form.custom_domain && (
                    <span
                      className={`text-xs px-2.5 py-0.5 rounded-full font-semibold border ${
                        form.custom_domain_status === 'verified'
                          ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                          : form.custom_domain_status === 'failed'
                          ? 'bg-red-500/15 border-red-500/30 text-red-300'
                          : 'bg-amber-500/15 border-amber-500/30 text-amber-300'
                      }`}
                    >
                      {form.custom_domain_status === 'verified'
                        ? '● Active & Verified'
                        : form.custom_domain_status === 'failed'
                        ? '● Verification Failed'
                        : '● DNS Pending'}
                    </span>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="custom_domain" className="text-xs font-semibold text-gray-300">
                    Host Domain
                  </label>
                  <div className="flex gap-2">
                    <input
                      id="custom_domain"
                      type="text"
                      placeholder="files.yourcompany.com"
                      value={form.custom_domain || ''}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          custom_domain: e.target.value.toLowerCase().replace(/^https?:\/\//, ''),
                          custom_domain_status: 'pending',
                        })
                      }
                      className="flex-1 bg-white/5 border border-white/10 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-primary/60 transition-colors font-mono"
                    />
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={verifying || !form.custom_domain}
                      onClick={handleVerifyDomain}
                    >
                      {verifying ? <Loader2 className="w-4 h-4 animate-spin mr-1.5" /> : <RefreshCw className="w-4 h-4 mr-1.5" />}
                      Check DNS
                    </Button>
                  </div>
                </div>

                {/* DNS Instructions */}
                <div className="bg-black/30 border border-white/5 rounded-xl p-4 text-xs space-y-2">
                  <p className="font-semibold text-gray-200">DNS Setup Instructions:</p>
                  <p className="text-gray-400">
                    In your DNS provider (Cloudflare, GoDaddy, AWS Route53), create a <code className="text-sky-300 font-mono">CNAME</code> record:
                  </p>
                  <div className="grid grid-cols-2 gap-2 bg-white/5 p-2 rounded-lg font-mono text-[11px]">
                    <div>
                      <span className="text-gray-500 block">Host / Name:</span>
                      <span className="text-white font-bold">{form.custom_domain?.split('.')[0] || 'files'}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 block">Target / Value:</span>
                      <span className="text-sky-400 font-bold">cname.datran.app</span>
                    </div>
                  </div>
                  <p className="text-[11px] text-gray-500">
                    Automatic SSL certificates are issued by Let&apos;s Encrypt within 5 minutes of DNS verification.
                  </p>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center justify-between pt-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setForm({
                      brand_name: '',
                      brand_logo_url: '',
                      brand_color: '#0284c7',
                      brand_wallpaper_url: '',
                      brand_tagline: '',
                      custom_domain: '',
                      custom_domain_status: 'pending',
                    });
                  }}
                >
                  Reset to Defaults
                </Button>

                <Button type="submit" variant="primary" disabled={saving}>
                  {saving ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <CheckCircle2 className="w-4 h-4 mr-2" />}
                  Save Brand Settings
                </Button>
              </div>
            </form>

            {/* Live Interactive Preview Column */}
            <div className="lg:col-span-5 sticky top-6 space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-gray-400 uppercase tracking-wider px-1">
                <span className="flex items-center gap-1.5">
                  <Eye className="w-4 h-4 text-sky-400" /> Live Client Preview
                </span>
                <span className="text-[11px] text-gray-500">What recipients see</span>
              </div>

              {/* Preview Window Mockup */}
              <div className="rounded-2xl border border-white/15 bg-black/60 shadow-2xl overflow-hidden relative">
                {/* Custom Wallpaper Background */}
                {form.brand_wallpaper_url && (
                  <div
                    className="absolute inset-0 bg-cover bg-center opacity-30 transition-opacity duration-500"
                    style={{ backgroundImage: `url(${form.brand_wallpaper_url})` }}
                  />
                )}
                <div className="absolute inset-0 bg-gradient-to-b from-black/80 via-black/90 to-black pointer-events-none" />

                {/* Mock Browser Top Bar */}
                <div className="relative z-10 flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-black/40">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
                    <div className="w-2.5 h-2.5 rounded-full bg-amber-500/80" />
                    <div className="w-2.5 h-2.5 rounded-full bg-emerald-500/80" />
                  </div>
                  <div className="flex-1 text-center">
                    <span className="inline-block px-3 py-0.5 rounded-full bg-white/5 border border-white/10 text-[10px] font-mono text-gray-400">
                      https://{form.custom_domain || 'files.datran.app'}/v1/demo-transfer
                    </span>
                  </div>
                </div>

                {/* Mock Content Header */}
                <div className="relative z-10 p-6 space-y-6">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      {form.brand_logo_url ? (
                        <img
                          src={form.brand_logo_url}
                          alt="Brand Logo"
                          className="h-7 w-auto object-contain rounded"
                          onError={(e) => {
                            (e.currentTarget as HTMLElement).style.display = 'none';
                          }}
                        />
                      ) : (
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center font-bold text-white text-xs shadow-md"
                          style={{ backgroundColor: form.brand_color || '#0284c7' }}
                        >
                          {(form.brand_name || 'D')[0]?.toUpperCase()}
                        </div>
                      )}
                      <div>
                        <span className="font-bold text-sm text-white">
                          {form.brand_name || 'Datran Transfer'}
                        </span>
                        {form.brand_tagline && (
                          <p className="text-[10px] text-gray-400">{form.brand_tagline}</p>
                        )}
                      </div>
                    </div>

                    <span className="text-[11px] text-gray-400 border border-white/10 px-2 py-0.5 rounded-md bg-white/5">
                      Verified Transfer
                    </span>
                  </div>

                  {/* Mock File Card */}
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="font-semibold text-white text-sm truncate">Campaign_Final_Deliverable.zip</p>
                        <p className="text-xs text-gray-400 mt-0.5">342.8 MB • End-to-End Encrypted</p>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled
                      className="w-full py-2.5 px-4 rounded-xl font-semibold text-xs text-white shadow-lg transition-transform"
                      style={{ backgroundColor: form.brand_color || '#0284c7' }}
                    >
                      Download Deliverables
                    </button>
                  </div>

                  {/* Preview Footer */}
                  <div className="text-center pt-2 pb-1 border-t border-white/10 text-[10px] text-gray-400">
                    ⚡ {form.brand_name ? `Powered by ${form.brand_name} • ` : ''}End-to-end encrypted with Datran
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}
