import Link from 'next/link';
import {
  ShieldCheck,
  RefreshCw,
  MessageSquare,
  Inbox,
  Palette,
  MailCheck,
  Terminal,
  Sparkles,
  ArrowRight,
  UploadCloud,
  Radio,
  FolderOpen,
  Lock,
  Zap,
  CheckCircle2,
  HardDrive,
} from 'lucide-react';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import UploadHistory from '@/components/features/UploadHistory';
import { getPlan, type PlanId } from '@/lib/billing/plans';
import { formatFileSize, formatHours } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function limitsFor(id: PlanId) {
  const p = getPlan(id);
  return {
    id: p.id,
    name: p.name,
    maxFileBytes: p.maxFileBytes,
    maxExpiryHours: p.maxExpiryHours,
    defaultExpiryHours: p.defaultExpiryHours,
    passwordLinks: p.passwordLinks,
  };
}

export default function HomePage() {
  const plans = { anonymous: limitsFor('anonymous'), free: limitsFor('free'), pro: limitsFor('pro') };

  const modalities = [
    {
      icon: UploadCloud,
      badge: 'Cloud & Resumable Link',
      title: 'Encrypted File Transfer',
      description:
        'Upload large datasets and files with resilient auto-resuming chunks. Encrypted in your browser before upload, generating secure auto-expiring links.',
      cta: 'Open Send Station',
      href: '/send',
      primary: true,
      features: ['Up to 100 GB per file', 'Browser zero-knowledge encryption', 'Auto-expiring password links'],
    },
    {
      icon: Radio,
      badge: 'Direct LAN & P2P Mesh',
      title: 'Radar Device Beam',
      description:
        'Stream files directly between phones, laptops, and tablets over local Wi-Fi or WebRTC mesh. Blazing LAN speeds with zero cloud storage.',
      cta: 'Launch Nearby Beam',
      href: '/radar',
      primary: false,
      features: ['Peer-to-peer direct streaming', 'Instant QR code & PIN pairing', 'Zero cloud bandwidth consumed'],
    },
    {
      icon: FolderOpen,
      badge: 'Portals & Collaboration',
      title: 'Shared Spaces & Inboxes',
      description:
        'Organize client workspaces and file dropzones where recipients can upload directly into your storage without needing an account.',
      cta: 'Explore Spaces & Inboxes',
      href: '/spaces',
      primary: false,
      features: ['Branded client upload dropzones', 'Timecoded media reviews', 'Approval audit trails'],
    },
  ];

  const features = [
    {
      icon: Lock,
      title: 'Zero-Knowledge Encryption',
      body: 'Zero-knowledge encryption in your browser before upload. Only you and your recipient hold the decryption key.',
    },
    {
      icon: RefreshCw,
      title: 'Fast & Resumable',
      body: 'Large files upload in reliable chunks. Drops automatically retry and resume from the exact byte where they paused.',
    },
    {
      icon: Inbox,
      title: 'Client File Requests',
      body: 'Share a branded link where clients can securely upload files directly into your storage without an account.',
    },
    {
      icon: MessageSquare,
      title: 'Review & Approve',
      body: 'Collaborate on media with timecoded comments, visual pinpoints, and formal approval workflows.',
    },
    {
      icon: MailCheck,
      title: 'Email Delivery & OTP',
      body: 'Send directly to recipient inboxes, track opens/downloads, and enforce secure one-time passcode access.',
    },
    {
      icon: Palette,
      title: 'Custom Branding',
      body: 'Customize your transfer and request pages with your company logo, custom colors, and custom domains.',
    },
    {
      icon: Terminal,
      title: 'Developer CLI & Native Core',
      body: 'Automate transfers with our high-performance Rust core reactor, personal API keys, and the datran CLI.',
    },
    {
      icon: HardDrive,
      title: 'Automated Lifecycle Purge',
      body: 'Files automatically self-destruct upon expiry or receipt, leaving zero residual traces in cloud storage.',
    },
  ];

  const steps = [
    {
      step: '01',
      title: 'Client-Side Encrypt',
      desc: 'Data is encrypted locally in your browser with AES-256-GCM before a single byte leaves your device.',
    },
    {
      step: '02',
      title: 'Resilient Chunk Stream',
      desc: 'Transfers upload in resilient, chunked streams that auto-resume if connection fluctuates.',
    },
    {
      step: '03',
      title: 'Share via Link or Beam',
      desc: 'Send through password-protected links, email OTPs, or direct P2P radar mesh without cloud limits.',
    },
    {
      step: '04',
      title: 'Automatic Purge',
      desc: 'Payloads self-destruct on your chosen schedule or immediately upon delivery confirmation.',
    },
  ];

  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 flex-col">
        {/* Hero Section */}
        <section aria-labelledby="hero-heading" className="pt-6 pb-14 text-center sm:pt-12 sm:pb-20">
          <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-4 py-1.5 text-xs font-medium text-primary sm:text-sm">
            <ShieldCheck className="h-4 w-4" aria-hidden="true" />
            <span>Industrial Zero-Knowledge Encryption • Native Rust Core</span>
          </div>

          <h1
            id="hero-heading"
            className="mt-6 text-4xl font-extrabold tracking-tight text-white sm:text-6xl sm:leading-[1.1]"
          >
            Send Big Files.<br />
            <span className="text-gradient-primary">Absolute Privacy. Zero Intermediaries.</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-base leading-relaxed text-gray-300 sm:text-lg">
            High-performance, cryptographic file transfer built for professionals. Send massive datasets, beam files
            directly between devices over local mesh, or collaborate in branded client spaces.
          </p>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Link
              href="/send"
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-7 py-3.5 text-base font-semibold text-on-primary shadow-lg shadow-primary/20 transition-all hover:bg-primary-light active:scale-[0.98]"
            >
              Start Sending Files
              <ArrowRight className="h-5 w-5" aria-hidden="true" />
            </Link>
            <Link
              href="/radar"
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-6 py-3.5 text-base font-medium text-white transition-all hover:bg-white/10 active:scale-[0.98]"
            >
              <Radio className="h-5 w-5 text-primary" aria-hidden="true" />
              Launch Nearby Beam
            </Link>
          </div>

          <div className="mt-10 flex flex-wrap items-center justify-center gap-6 text-xs font-medium text-gray-400 sm:text-sm">
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-emerald-400" />
              Browser-side encryption
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-cyan-400" />
              Resumable chunk stream
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-amber-400" />
              Auto-expiring links
            </span>
            <span className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-primary" />
              Direct P2P radar mesh
            </span>
          </div>
        </section>

        {/* 3 Core Modes Section */}
        <section aria-labelledby="modalities-heading" className="py-8">
          <div className="mb-8 text-center sm:mb-12">
            <h2 id="modalities-heading" className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Three Distinct Ways to Transfer
            </h2>
            <p className="mt-2 text-sm text-gray-400 sm:text-base">
              Choose the right workflow for your payload, recipients, and security requirements.
            </p>
          </div>

          <div className="grid gap-6 md:grid-cols-3">
            {modalities.map(({ icon: Icon, badge, title, description, cta, href, primary, features: items }) => (
              <div
                key={title}
                className={`panel flex flex-col justify-between p-6 transition-all sm:p-8 ${
                  primary ? 'border-primary/40 bg-surface-raised shadow-xl shadow-primary/5' : 'hover:border-white/20'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span
                      className={`grid h-12 w-12 place-items-center rounded-2xl border ${
                        primary
                          ? 'border-primary/30 bg-primary/10 text-primary'
                          : 'border-white/10 bg-white/5 text-gray-300'
                      }`}
                    >
                      <Icon className="h-6 w-6" aria-hidden="true" />
                    </span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-gray-300">
                      {badge}
                    </span>
                  </div>

                  <h3 className="mt-5 text-xl font-bold text-white">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-gray-300">{description}</p>

                  <ul className="mt-6 space-y-2 border-t border-white/10 pt-5 text-xs text-gray-400">
                    {items.map((item) => (
                      <li key={item} className="flex items-center gap-2">
                        <CheckCircle2 className="h-3.5 w-3.5 text-primary shrink-0" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="mt-8 pt-4">
                  <Link
                    href={href}
                    className={`inline-flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition-all ${
                      primary
                        ? 'bg-primary text-on-primary hover:bg-primary-light'
                        : 'border border-white/15 bg-white/5 text-white hover:bg-white/10'
                    }`}
                  >
                    <span>{cta}</span>
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* How It Works */}
        <section aria-labelledby="steps-heading" className="py-12 sm:py-16">
          <div className="panel p-8 sm:p-12">
            <div className="mb-10 text-center">
              <span className="text-xs font-semibold uppercase tracking-wider text-primary">Architecture</span>
              <h2 id="steps-heading" className="mt-2 text-2xl font-bold text-white sm:text-3xl">
                Engineered for Integrity & Privacy
              </h2>
              <p className="mt-2 text-sm text-gray-400">
                How Datran moves files safely across untrusted networks.
              </p>
            </div>

            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map(({ step, title, desc }) => (
                <div key={step} className="rounded-xl border border-white/5 bg-white/[0.02] p-5">
                  <div className="text-2xl font-black text-primary/40">{step}</div>
                  <h3 className="mt-3 font-semibold text-white">{title}</h3>
                  <p className="mt-1.5 text-xs leading-relaxed text-gray-400">{desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section aria-labelledby="features-heading" className="py-8 sm:py-12">
          <div className="mb-10 text-center">
            <h2 id="features-heading" className="text-2xl font-bold text-white sm:text-3xl">
              Complete Feature Arsenal
            </h2>
            <p className="mt-2 text-sm text-gray-400">
              Built for high-stakes workflows, agency handoffs, and heavy datasets.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ icon: Icon, title, body }) => (
              <div key={title} className="panel p-5">
                <span
                  className="mb-3 grid h-10 w-10 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary"
                  aria-hidden="true"
                >
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="font-semibold text-white">{title}</h3>
                <p className="mt-1.5 text-xs leading-relaxed text-gray-300">{body}</p>
              </div>
            ))}

            <div className="panel relative flex flex-col justify-between overflow-hidden border-primary/30 p-5 sm:col-span-2 lg:col-span-4 lg:flex-row lg:items-center">
              <div>
                <div className="flex items-center gap-2">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-on-primary">
                    <Sparkles className="h-4 w-4" />
                  </span>
                  <h3 className="font-bold text-white">Need higher throughput or custom retention?</h3>
                </div>
                <p className="mt-2 max-w-2xl text-xs leading-relaxed text-gray-300 sm:text-sm">
                  The Pro tier raises payload limits to {formatFileSize(plans.pro.maxFileBytes)} per transfer and keeps
                  links alive for up to {formatHours(plans.pro.maxExpiryHours)}. Includes custom CNAME branding and
                  unlimited dropzones.
                </p>
              </div>
              <Link
                href="/billing"
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-xs font-semibold text-on-primary hover:bg-primary-light lg:mt-0 shrink-0"
              >
                <span>View Pro Tier Plans</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <Footer />
      <UploadHistory />
    </div>
  );
}
