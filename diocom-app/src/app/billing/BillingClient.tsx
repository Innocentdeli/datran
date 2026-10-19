'use client';

import { useState } from 'react';
import { CreditCard, HardDrive, ArrowDownToLine, Coins, Sparkles, AlertTriangle } from 'lucide-react';
import { buttonClasses } from '@/components/ui/Button';
import type { BillingSummary } from '@/lib/billing/summary';
import type { LedgerEntry } from '@/lib/billing/credits';

function fmtBytes(n: number | null): string {
    if (n === null) return 'Unlimited';
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`;
}

const fmtHours = (h: number) => (h >= 48 ? `up to ${Math.round(h / 24)} days` : `up to ${h} hours`);
const fmtCredits = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 4 });
const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');

function UsageBar({ icon, label, used, quota, note }: { icon: React.ReactNode; label: string; used: number; quota: number | null; note?: string }) {
    const pct = quota ? Math.min(100, (used / Math.max(quota, 1)) * 100) : 0;
    const color = pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-400' : 'bg-primary';
    return (
        <div className="panel p-5">
            <div className="flex items-center justify-between mb-3">
                <span className="flex items-center gap-2 text-sm font-medium text-gray-200">{icon}{label}</span>
                <span className="text-sm font-mono text-gray-200">{fmtBytes(used)} / {fmtBytes(quota)}</span>
            </div>
            <div className="h-2 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
                <div className={`h-full ${color} transition-all`} style={{ width: `${quota ? pct : 0}%` }} />
            </div>
            {note ? <p className="text-xs text-gray-400 mt-2">{note}</p> : null}
        </div>
    );
}

export default function BillingClient({ summary, ledger, checkout }: { summary: BillingSummary; ledger: LedgerEntry[]; checkout: string | null }) {
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const { billing, plan, usage, credits, subscription, plans } = summary;
    const isPro = plan.id === 'pro';

    async function go(key: string, path: string, body?: unknown) {
        setBusy(key);
        setError(null);
        try {
            const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.url) throw new Error(data.error || `Request failed (${res.status})`);
            window.location.href = data.url;
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setBusy(null);
        }
    }

    return (
        <div className="flex flex-col gap-6">
            {!billing.configured ? (
                <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 text-amber-300 rounded-2xl px-5 py-4 text-sm">
                    <AlertTriangle size={16} /> Billing is not configured on this server. All accounts use the Free plan.
                </div>
            ) : null}
            {checkout === 'success' ? (
                <div className="bg-primary/10 border border-primary/20 text-primary rounded-2xl px-5 py-4 text-sm">
                    Thanks! Your payment is being confirmed — your plan and credits update as soon as Stripe notifies us (usually within seconds). Refresh to see it.
                </div>
            ) : null}
            {checkout === 'cancelled' ? <div className="bg-white/5 border border-white/10 text-gray-300 rounded-2xl px-5 py-4 text-sm">Checkout cancelled. Nothing was charged.</div> : null}
            {error ? <div className="bg-red-500/10 border border-red-500/20 text-red-300 rounded-2xl px-5 py-4 text-sm" role="alert">{error}</div> : null}
            {subscription?.inGracePeriod ? (
                <div className="flex items-center gap-3 bg-amber-500/10 border border-amber-500/20 text-amber-300 rounded-2xl px-5 py-4 text-sm">
                    <AlertTriangle size={16} /> Your last payment failed. Pro stays active for a short grace period — update your payment method under “Manage subscription”.
                </div>
            ) : null}

            {/* Current plan */}
            <section className="panel p-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                    <span className="text-sm text-gray-400">Current plan</span>
                    <div className="flex items-center gap-2 mt-1">
                        <span className="text-2xl font-bold text-white">{plan.name}</span>
                        {isPro ? <Sparkles size={18} className="text-primary" /> : null}
                    </div>
                    {subscription && isPro ? (
                        <p className="text-xs text-gray-400 mt-1">
                            {subscription.interval === 'year' ? 'Yearly' : subscription.interval === 'month' ? 'Monthly' : ''} · {subscription.cancelAtPeriodEnd ? 'ends' : 'renews'} {fmtDate(subscription.currentPeriodEnd)}
                        </p>
                    ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                    {billing.configured && !isPro && billing.proMonthly ? (
                        <button type="button" disabled={!!busy} onClick={() => go('month', '/api/billing/checkout', { kind: 'pro', interval: 'month' })}
                            className={buttonClasses('primary', 'md')}>
                            {busy === 'month' ? 'Redirecting…' : 'Upgrade · Monthly'}
                        </button>
                    ) : null}
                    {billing.configured && !isPro && billing.proYearly ? (
                        <button type="button" disabled={!!busy} onClick={() => go('year', '/api/billing/checkout', { kind: 'pro', interval: 'year' })}
                            className={buttonClasses('secondary', 'md', 'border-primary/40 text-primary')}>
                            {busy === 'year' ? 'Redirecting…' : 'Upgrade · Yearly'}
                        </button>
                    ) : null}
                    {billing.configured && subscription ? (
                        <button type="button" disabled={!!busy} onClick={() => go('portal', '/api/billing/portal')}
                            className={buttonClasses('secondary', 'md')}>
                            <CreditCard size={12} /> {busy === 'portal' ? 'Opening…' : 'Manage subscription'}
                        </button>
                    ) : null}
                </div>
            </section>

            {/* Usage */}
            <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <UsageBar icon={<HardDrive size={12} />} label="Storage" used={usage.storageBytes} quota={usage.storageQuotaBytes} note="Live files; freed when links expire." />
                <UsageBar icon={<ArrowDownToLine size={12} />} label="Downloads this month" used={usage.egressBytes} quota={usage.egressQuotaBytes}
                    note={`Resets ${fmtDate(usage.resetsAt)}.${usage.egressCreditedBytes ? ` ${fmtBytes(usage.egressCreditedBytes)} paid with credits.` : ''}`} />
            </section>
            <p className="text-xs text-gray-400 -mt-3">
                {plan.name} limits: {fmtBytes(plan.maxFileBytes)} per file · links up to {plan.maxExpiryHours >= 48 ? `${Math.round(plan.maxExpiryHours / 24)} days` : `${plan.maxExpiryHours} hours`}
                {usage.monthlyUploads !== null ? ` · ${usage.uploadsThisMonth}/${usage.monthlyUploads} uploads this month` : ` · ${usage.uploadsThisMonth} uploads this month`}
                {!isPro ? ` — Pro: ${fmtBytes(plans.pro.storageQuotaBytes)} storage, ${fmtBytes(plans.pro.monthlyEgressBytes)}/month downloads.` : ''}
            </p>

            {/* Plan comparison (real configured limits) */}
            <section aria-labelledby="compare-heading" tabIndex={0} className="panel overflow-x-auto p-6">
                <h2 id="compare-heading" className="mb-4 text-sm font-medium text-gray-200">Compare plans</h2>
                <table className="w-full min-w-[22rem] text-left text-sm">
                    <thead>
                        <tr className="border-b border-white/10 text-gray-400">
                            <th scope="col" className="py-2 pr-4 font-normal"><span className="sr-only">Limit</span></th>
                            <th scope="col" className="py-2 pr-4 font-medium text-gray-200">{plans.free.name}{!isPro ? <span className="ml-2 text-xs font-normal text-gray-400">(current)</span> : null}</th>
                            <th scope="col" className="py-2 font-medium text-primary">{plans.pro.name}{isPro ? <span className="ml-2 text-xs font-normal text-gray-400">(current)</span> : null}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-gray-200">
                        {([
                            ['Per file', fmtBytes(plans.free.maxFileBytes), fmtBytes(plans.pro.maxFileBytes)],
                            ['Storage', fmtBytes(plans.free.storageQuotaBytes), fmtBytes(plans.pro.storageQuotaBytes)],
                            ['Downloads / month', fmtBytes(plans.free.monthlyEgressBytes), fmtBytes(plans.pro.monthlyEgressBytes)],
                            ['Link lifetime', fmtHours(plans.free.maxExpiryHours), fmtHours(plans.pro.maxExpiryHours)],
                            ['Password links', plans.free.passwordLinks ? 'Yes' : 'No', plans.pro.passwordLinks ? 'Yes' : 'No'],
                        ] as const).map(([label, free, pro]) => (
                            <tr key={label}>
                                <th scope="row" className="py-2 pr-4 font-normal text-gray-400">{label}</th>
                                <td className="py-2 pr-4">{free}</td>
                                <td className="py-2">{pro}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </section>

            {/* Credits */}
            <section className="panel p-6 flex flex-col gap-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                        <span className="flex items-center gap-2 text-sm text-gray-400"><Coins size={14} aria-hidden="true" /> Credits</span>
                        <span className="text-2xl font-bold text-primary">{fmtCredits(credits.balance)}</span>
                        <p className="text-xs text-gray-400 mt-1">Pay for downloads beyond your monthly allowance: {fmtCredits(credits.creditsPerGb)} credit{credits.creditsPerGb === 1 ? '' : 's'} per GB.</p>
                    </div>
                    {billing.configured && billing.creditPacks.length ? (
                        <div className="flex flex-wrap gap-2">
                            {billing.creditPacks.map((n) => (
                                <button key={n} disabled={!!busy} onClick={() => go(`c${n}`, '/api/billing/checkout', { kind: 'credits', credits: n })}
                                    className={buttonClasses('secondary', 'sm')}>
                                    {busy === `c${n}` ? 'Redirecting…' : `Buy ${n}`}
                                </button>
                            ))}
                        </div>
                    ) : null}
                </div>
                <div className="border-t border-white/10 pt-4">
                    <h2 className="text-sm font-medium text-gray-200">Credit history</h2>
                    {ledger.length === 0 ? (
                        <p className="text-sm text-gray-400 mt-2">No credit activity yet.</p>
                    ) : (
                        <ul className="mt-2 divide-y divide-white/5">
                            {ledger.map((e) => (
                                <li key={e.id} className="flex items-center justify-between py-2 text-sm gap-4">
                                    <div className="min-w-0">
                                        <p className="text-gray-200 truncate">{e.reason || e.type}</p>
                                        <p className="text-xs text-gray-400">{new Date(e.timestamp).toLocaleString()}</p>
                                    </div>
                                    <span className={`font-mono shrink-0 ${e.amount >= 0 ? 'text-primary' : 'text-gray-300'}`}>
                                        {e.amount >= 0 ? '+' : ''}{fmtCredits(e.amount)}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </section>
        </div>
    );
}
