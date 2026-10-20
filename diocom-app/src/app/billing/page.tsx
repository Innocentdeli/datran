import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '@/lib/auth/options';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import { getBillingSummary, getLedger } from '@/lib/billing/summary';
import BillingClient from './BillingClient';

export const dynamic = 'force-dynamic';

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) redirect('/auth/signin?callbackUrl=/billing');
    const params = await searchParams;
    const [summary, ledger] = await Promise.all([getBillingSummary(session.user.id), getLedger(session.user.id, 50)]);

    return (
        <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
            <Header />
            <main id="main" className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-white">Plan &amp; billing</h1>
                    <p className="mt-1 text-sm text-gray-300">Your plan, usage this month, credits and subscription.</p>
                </div>
                <BillingClient summary={summary} ledger={ledger} checkout={params?.checkout ?? null} />
            </main>
            <Footer />
        </div>
    );
}
