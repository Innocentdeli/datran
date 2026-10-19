import { getServerSession } from 'next-auth';
import { redirect } from 'next/navigation';
import { authOptions } from '../api/auth/[...nextauth]/route';
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
        <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center p-4 sm:p-8 font-sans selection:bg-primary/30">
            <div className="fixed inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-gray-900/40 via-black to-black -z-10" />
            <Header />
            <main className="w-full max-w-5xl flex-1 flex flex-col gap-8">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight text-white mb-1">Plan &amp; Billing</h2>
                    <p className="text-xs text-gray-400 font-medium tracking-wide uppercase">Usage, credits and subscription</p>
                </div>
                <BillingClient summary={summary} ledger={ledger} checkout={params?.checkout ?? null} />
            </main>
            <Footer />
        </div>
    );
}
