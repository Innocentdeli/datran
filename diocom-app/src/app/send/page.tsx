import Header from '@/components/layout/Header';
import UploadPanel, { type UploadPlanLimits } from '@/components/features/UploadPanel';
import UploadHistory from '@/components/features/UploadHistory';
import { getPlan, type PlanId } from '@/lib/billing/plans';

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

export default function SendPage() {
  const plans = { anonymous: limitsFor('anonymous'), free: limitsFor('free'), pro: limitsFor('pro') };

  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main id="main" className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center py-6 sm:py-10">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Encrypted Transfer Workspace
          </h1>
          <p className="mt-1.5 text-sm text-gray-400">
            Zero-knowledge encryption in your browser before upload. Generates a secure, auto-expiring link.
          </p>
        </div>

        <UploadPanel plans={plans} />
      </main>

      <UploadHistory />
    </div>
  );
}
