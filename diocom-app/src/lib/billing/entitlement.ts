import db from '@/db';
import { getPlan, graceDays, type PlanId, type PlanLimits } from './plans';

/**
 * Entitlement = derived ONLY from the subscription state stored locally by the Stripe webhook (never from a
 * client-side checkout redirect). Pro while a subscription is active or trialing, or past_due within the grace
 * period (BILLING_GRACE_DAYS). Without STRIPE_SECRET_KEY billing is "not configured" and every account is Free.
 */

export function billingConfigured(): boolean {
    return !!process.env.STRIPE_SECRET_KEY;
}

export interface SubscriptionRow {
    id: string;
    user_id: string;
    stripe_customer_id: string | null;
    status: string;
    plan: string;
    billing_interval: string | null;
    price_id: string | null;
    current_period_end: number | null;
    cancel_at_period_end: boolean;
    past_due_since: number | null;
    event_created: number;
    updated_at: number;
}

const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function normalize(r: Record<string, unknown>): SubscriptionRow {
    return {
        id: String(r.id),
        user_id: String(r.user_id),
        stripe_customer_id: (r.stripe_customer_id as string | null) ?? null,
        status: String(r.status),
        plan: String(r.plan ?? 'pro'),
        billing_interval: (r.billing_interval as string | null) ?? null,
        price_id: (r.price_id as string | null) ?? null,
        current_period_end: n(r.current_period_end),
        cancel_at_period_end: r.cancel_at_period_end === true || r.cancel_at_period_end === 'true' || r.cancel_at_period_end === 1,
        past_due_since: n(r.past_due_since),
        event_created: Number(r.event_created ?? 0),
        updated_at: Number(r.updated_at ?? 0),
    };
}

/** True when this subscription grants Pro at `now`. */
export function isEntitled(sub: Pick<SubscriptionRow, 'status' | 'past_due_since'>, now = Date.now(), graceMs = graceDays() * 86_400_000): boolean {
    if (sub.status === 'active' || sub.status === 'trialing') return true;
    if (sub.status === 'past_due') {
        const since = sub.past_due_since ?? now;
        return now - since <= graceMs;
    }
    return false;
}

export function inGracePeriod(sub: Pick<SubscriptionRow, 'status' | 'past_due_since'>, now = Date.now()): boolean {
    return sub.status === 'past_due' && isEntitled(sub, now);
}

export async function listSubscriptions(userId: string): Promise<SubscriptionRow[]> {
    const res = await db.query('SELECT * FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC', [userId]);
    return res.rows.map(normalize);
}

/** The subscription that matters for display: an entitling one first, else the most recent. */
export async function currentSubscription(userId: string, now = Date.now()): Promise<SubscriptionRow | null> {
    const subs = await listSubscriptions(userId);
    return subs.find((s) => isEntitled(s, now)) ?? subs[0] ?? null;
}

export async function getUserPlanId(userId: string | null | undefined, now = Date.now()): Promise<PlanId> {
    if (!userId) return 'anonymous';
    if (!billingConfigured()) return 'free';
    const subs = await listSubscriptions(userId);
    return subs.some((s) => isEntitled(s, now)) ? 'pro' : 'free';
}

export async function getUserPlan(userId: string | null | undefined, now = Date.now()): Promise<PlanLimits> {
    return getPlan(await getUserPlanId(userId, now));
}
