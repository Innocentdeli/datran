import Link from 'next/link';
import { ShieldCheck, RefreshCw, Clock, Sparkles, ArrowRight } from 'lucide-react';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import UploadPanel, { type UploadPlanLimits } from '@/components/features/UploadPanel';
import UploadHistory from '@/components/features/UploadHistory';
import { getPlan, type PlanId } from '@/lib/billing/plans';
import { formatFileSize, formatHours } from '@/lib/utils';

// Plan limits are read from the environment at request time (operators can change them without a rebuild).
export const dynamic = 'force-dynamic';

function limitsFor(id: PlanId): UploadPlanLimits {
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

  const features = [
    {
      icon: ShieldCheck,
      title: 'End-to-end encrypted',
      body: 'Files are encrypted with AES-GCM in your browser before upload. The key lives in the link after “#”, which browsers never send to the server.',
    },
    {
      icon: RefreshCw,
      title: 'Resumable uploads',
      body: 'Large files upload in chunks. Dropped connections retry and continue from where they stopped — even after a reload, by picking the same file again.',
    },
    {
      icon: Clock,
      title: 'Links that expire',
      body: `Choose how long a link stays alive (up to ${formatHours(plans.free.maxExpiryHours)} on Free) and add an optional password recipients must enter.`,
    },
  ];

  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main id="main" className="mx-auto flex w-full max-w-6xl flex-1 flex-col">
        <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:gap-14">
          <div className="pt-2 lg:pt-10">
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> Encrypted before it leaves your device
            </p>
            <h1 className="text-4xl font-bold leading-[1.1] tracking-tight text-white sm:text-5xl lg:text-6xl">
              Send big files.<br />
              <span className="text-primary">Keep them private.</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-gray-300 sm:text-lg">
              Drop a file, get a link. Datran encrypts it in your browser, resumes interrupted uploads, and shares it
              with a link that expires on your schedule — with an optional password.
            </p>
            <dl className="mt-8 grid max-w-xl grid-cols-1 gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <dt className="text-gray-400">No account</dt>
                <dd className="mt-0.5 font-medium text-white">{formatFileSize(plans.anonymous.maxFileBytes)} · {formatHours(plans.anonymous.maxExpiryHours)}</dd>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3">
                <dt className="text-gray-400">Free account</dt>
                <dd className="mt-0.5 font-medium text-white">{formatFileSize(plans.free.maxFileBytes)} · {formatHours(plans.free.maxExpiryHours)}</dd>
              </div>
              <div className="rounded-xl border border-primary/25 bg-primary/[0.06] px-4 py-3">
                <dt className="text-primary">Pro</dt>
                <dd className="mt-0.5 font-medium text-white">{formatFileSize(plans.pro.maxFileBytes)} · {formatHours(plans.pro.maxExpiryHours)}</dd>
              </div>
            </dl>
            <p className="mt-2 text-xs text-gray-400">Per-file size limit · longest link lifetime</p>
          </div>

          <UploadPanel plans={plans} />
        </div>

        <section aria-labelledby="features-heading" className="mt-16 sm:mt-24">
          <h2 id="features-heading" className="sr-only">Features</h2>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ icon: Icon, title, body }) => (
              <li key={title} className="panel p-5">
                <span className="mb-3 grid h-10 w-10 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary" aria-hidden="true">
                  <Icon className="h-5 w-5" />
                </span>
                <h3 className="font-semibold text-white">{title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-gray-300">{body}</p>
              </li>
            ))}
            <li className="panel relative flex flex-col overflow-hidden border-primary/30 p-5">
              <span className="mb-3 grid h-10 w-10 place-items-center rounded-xl bg-primary text-on-primary" aria-hidden="true">
                <Sparkles className="h-5 w-5" />
              </span>
              <h3 className="font-semibold text-white">Need more room?</h3>
              <p className="mt-1.5 flex-1 text-sm leading-relaxed text-gray-300">
                Pro raises the limit to {formatFileSize(plans.pro.maxFileBytes)} per file and keeps links alive for up to {formatHours(plans.pro.maxExpiryHours)}.
              </p>
              <Link href="/billing" className="mt-4 inline-flex items-center gap-1.5 self-start rounded-lg text-sm font-semibold text-primary hover:underline underline-offset-4">
                See Pro plan <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </Link>
            </li>
          </ul>
        </section>
      </main>

      <Footer />
      <UploadHistory />
    </div>
  );
}
