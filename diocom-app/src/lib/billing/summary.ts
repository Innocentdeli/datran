import { getPlan, creditsPerGb, usagePeriod, periodResetAt, type PlanLimits } from './plans';
import { currentSubscription, getUserPlanId, inGracePeriod } from './entitlement';
import { getBalance, listLedger, type LedgerEntry } from './credits';
import { billableEgress, getMonthlyUsage, getStorageUsage } from './usage';
import { billingStatus, type BillingStatus } from './stripe';

/** Everything the /billing page and GET /api/billing/usage show, with real numbers. */
export interface BillingSummary {
    billing: BillingStatus;
    plan: PlanLimits;
    plans: { free: PlanLimits; pro: PlanLimits };
    usage: {
        period: string;
        resetsAt: number;
        storageBytes: number;
        storageQuotaBytes: number | null;
        egressBytes: number;
        egressCreditedBytes: number;
        egressQuotaBytes: number | null;
        uploadsThisMonth: number;
        monthlyUploads: number | null;
    };
    credits: { balance: number; creditsPerGb: number };
    subscription: null | {
        status: string;
        interval: string | null;
        currentPeriodEnd: number | null;
        cancelAtPeriodEnd: boolean;
        inGracePeriod: boolean;
    };
}

export async function getBillingSummary(userId: string): Promise<BillingSummary> {
    const period = usagePeriod();
    const [planId, storage, egress, monthly, balance, sub] = await Promise.all([
        getUserPlanId(userId),
        getStorageUsage(userId),
        billableEgress(userId, period),
        getMonthlyUsage(userId, period),
        getBalance(userId),
        currentSubscription(userId),
    ]);
    const plan = getPlan(planId);
    return {
        billing: billingStatus(),
        plan,
        plans: { free: getPlan('free'), pro: getPlan('pro') },
        usage: {
            period,
            resetsAt: periodResetAt(),
            storageBytes: storage.storageBytes,
            storageQuotaBytes: plan.storageQuotaBytes,
            egressBytes: egress.billable,
            egressCreditedBytes: egress.credited,
            egressQuotaBytes: plan.monthlyEgressBytes,
            uploadsThisMonth: monthly.uploadsCount,
            monthlyUploads: plan.monthlyUploads,
        },
        credits: { balance, creditsPerGb: creditsPerGb() },
        subscription: sub ? {
            status: sub.status,
            interval: sub.billing_interval,
            currentPeriodEnd: sub.current_period_end,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
            inGracePeriod: inGracePeriod(sub),
        } : null,
    };
}

export async function getLedger(userId: string, limit = 50): Promise<LedgerEntry[]> {
    return listLedger(userId, limit);
}
