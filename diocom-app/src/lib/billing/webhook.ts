import Stripe from 'stripe';
import db from '@/db';
import { createModuleLogger } from '../observability/logger';
import { recordStripeWebhook } from '../observability/metrics';
import { grantCredits, clawbackCredits, round6 } from './credits';
import { getStripe, intervalForPrice } from './stripe';

const log = createModuleLogger('stripe-webhook');

/**
 * Stripe webhook processing (POST /api/billing/webhook).
 *  - Signature: verified over the RAW body with STRIPE_WEBHOOK_SECRET (stripe.webhooks.constructEvent).
 *  - Idempotency: processed_events (event id PRIMARY KEY) skips redeliveries; every handler is itself idempotent
 *    (credit grants/clawbacks carry idempotency keys, subscription upserts ignore events older than the stored state),
 *    so two concurrent deliveries of one event are harmless. A handler error answers 500 -> Stripe retries.
 *  - Handled: checkout.session.completed (+ async_payment_succeeded), customer.subscription.created/updated/deleted,
 *    invoice.paid, invoice.payment_failed (grace period starts), charge.refunded (claws back unused credits).
 */

export type WebhookOutcome = 'processed' | 'duplicate' | 'ignored';

export interface WebhookHttpResult {
    status: number;
    body: Record<string, unknown>;
}

const MAX_BODY_BYTES = 1024 * 1024;

/** Verifies the signature and processes the event. Pure of Next.js, so it is unit-testable. */
export async function handleStripeWebhook(rawBody: Buffer | string, signature: string | null, opts: { secret?: string; stripe?: Stripe | null } = {}): Promise<WebhookHttpResult> {
    const secret = opts.secret ?? process.env.STRIPE_WEBHOOK_SECRET;
    const stripe = opts.stripe === undefined ? getStripe() : opts.stripe;
    if (!stripe || !secret) return { status: 503, body: { error: 'Billing is not configured' } };
    if (!signature) {
        recordStripeWebhook('unknown', 'invalid_signature');
        return { status: 400, body: { error: 'Missing Stripe-Signature header' } };
    }
    if (Buffer.byteLength(rawBody) > MAX_BODY_BYTES) return { status: 413, body: { error: 'Payload too large' } };
    let event: Stripe.Event;
    try {
        event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch (e) {
        recordStripeWebhook('unknown', 'invalid_signature');
        log.warn({ err: e instanceof Error ? e.message : String(e) }, 'invalid webhook signature');
        return { status: 400, body: { error: 'Invalid signature' } };
    }
    try {
        const outcome = await processStripeEvent(event, stripe);
        recordStripeWebhook(event.type, outcome);
        return { status: 200, body: { received: true, outcome } };
    } catch (e) {
        recordStripeWebhook(event.type, 'error');
        log.error({ err: e, eventId: event.id, type: event.type }, 'webhook processing failed');
        return { status: 500, body: { error: 'Webhook processing failed' } };
    }
}

export async function processStripeEvent(event: Stripe.Event, stripe: Stripe): Promise<WebhookOutcome> {
    const seen = await db.query('SELECT id FROM processed_events WHERE id = $1', [event.id]);
    if (seen.rowCount) return 'duplicate';
    const handled = await dispatch(event, stripe);
    await db.query('INSERT INTO processed_events (id, type, processed_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [event.id, event.type, Date.now()]);
    return handled ? 'processed' : 'ignored';
}

async function dispatch(event: Stripe.Event, stripe: Stripe): Promise<boolean> {
    const createdMs = (event.created || 0) * 1000;
    switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
            return onCheckoutCompleted(event.data.object as Stripe.Checkout.Session, stripe, createdMs);
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
            return onSubscription(event.data.object as Stripe.Subscription, createdMs, event.type === 'customer.subscription.deleted');
        case 'invoice.paid':
            return onInvoicePaid(event.data.object as Stripe.Invoice);
        case 'invoice.payment_failed':
            return onInvoiceFailed(event.data.object as Stripe.Invoice);
        case 'charge.refunded':
            return onChargeRefunded(event.data.object as Stripe.Charge);
        default:
            return false;
    }
}

const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === 'string' ? v : v?.id ?? null);

/** Maps an event to a local user: metadata.userId / client_reference_id (verified to exist), else the customer id. */
async function resolveUser(candidate: string | null | undefined, customerId: string | null): Promise<string | null> {
    if (candidate) {
        const r = await db.query('SELECT * FROM users WHERE id = $1', [candidate]);
        if (r.rows[0]) return candidate;
    }
    if (customerId) {
        const r = await db.query('SELECT id FROM users WHERE stripe_customer_id = $1', [customerId]);
        if (r.rows[0]) return String(r.rows[0].id);
    }
    return null;
}

/** Remembers the customer for the user. A customer id already linked to ANOTHER account is logged, not fatal
 *  (otherwise Stripe would retry the event forever and the purchase would never be credited). */
async function linkCustomer(userId: string, customerId: string | null) {
    if (!customerId) return;
    try {
        await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [customerId, userId]);
    } catch (e) {
        if ((e as { code?: string }).code !== '23505' && !/unique|duplicate/i.test(String((e as Error).message))) throw e;
        log.warn({ userId, customerId }, 'stripe customer already linked to another user; not re-linked');
    }
}

async function onCheckoutCompleted(session: Stripe.Checkout.Session, stripe: Stripe, createdMs: number): Promise<boolean> {
    const customerId = idOf(session.customer as string | { id: string } | null);
    const userId = await resolveUser(session.metadata?.userId ?? session.client_reference_id, customerId);
    if (!userId) {
        log.warn({ session: session.id }, 'checkout session for unknown user');
        return false;
    }
    await linkCustomer(userId, customerId);

    if (session.mode === 'payment' && session.metadata?.kind === 'credits') {
        if (session.payment_status !== 'paid') return false; // async methods: wait for async_payment_succeeded
        const credits = Number(session.metadata.credits);
        if (!Number.isFinite(credits) || credits <= 0) return false;
        const paymentIntent = idOf(session.payment_intent as string | { id: string } | null) ?? `cs:${session.id}`;
        await grantCredits(userId, credits, {
            type: 'purchase',
            reason: `Credit pack: ${credits} credits`,
            idempotencyKey: `stripe:checkout:${session.id}`,
            extra: async (client) => {
                await client.query(
                    'INSERT INTO credit_purchases (payment_intent, user_id, checkout_session, credits, amount_paid, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (payment_intent) DO NOTHING',
                    [paymentIntent, userId, session.id, credits, session.amount_total ?? 0, Date.now()],
                );
            },
        });
        return true;
    }

    if (session.mode === 'subscription' && session.subscription) {
        const sub = typeof session.subscription === 'string' ? await stripe.subscriptions.retrieve(session.subscription) : session.subscription;
        await upsertSubscription(sub, userId, createdMs);
        return true;
    }
    return false;
}

async function onSubscription(sub: Stripe.Subscription, createdMs: number, deleted: boolean): Promise<boolean> {
    const customerId = idOf(sub.customer as string | { id: string });
    const userId = await resolveUser(sub.metadata?.userId, customerId);
    if (!userId) {
        log.warn({ subscription: sub.id }, 'subscription for unknown user');
        return false;
    }
    await upsertSubscription(deleted ? { ...sub, status: 'canceled' } : sub, userId, createdMs);
    return true;
}

/** Applies the subscription state unless a newer event was already applied. */
export async function upsertSubscription(sub: Stripe.Subscription, userId: string, eventCreatedMs: number): Promise<void> {
    const item = sub.items?.data?.[0];
    const priceId = item?.price?.id ?? null;
    const interval = item?.price?.recurring?.interval ?? intervalForPrice(priceId);
    const legacyEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
    const periodEnd = item?.current_period_end ?? legacyEnd ?? null;
    const now = Date.now();
    await db.query(
        `INSERT INTO subscriptions (id, user_id, stripe_customer_id, status, plan, billing_interval, price_id, current_period_end, cancel_at_period_end, past_due_since, event_created, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id, stripe_customer_id = EXCLUDED.stripe_customer_id, status = EXCLUDED.status, plan = EXCLUDED.plan, billing_interval = EXCLUDED.billing_interval, price_id = EXCLUDED.price_id, current_period_end = EXCLUDED.current_period_end, cancel_at_period_end = EXCLUDED.cancel_at_period_end, past_due_since = CASE WHEN EXCLUDED.status = 'past_due' THEN COALESCE(subscriptions.past_due_since, EXCLUDED.past_due_since) ELSE NULL END, event_created = EXCLUDED.event_created, updated_at = EXCLUDED.updated_at WHERE subscriptions.event_created <= EXCLUDED.event_created`,
        [
            sub.id, userId, idOf(sub.customer as string | { id: string }), sub.status, 'pro', interval ?? null, priceId,
            periodEnd ? periodEnd * 1000 : null, !!sub.cancel_at_period_end, sub.status === 'past_due' ? now : null, eventCreatedMs, now,
        ],
    );
    log.info({ userId, subscription: sub.id, status: sub.status }, 'subscription state applied');
}

function invoiceSubscriptionId(inv: Stripe.Invoice): string | null {
    const parent = (inv as unknown as { parent?: { subscription_details?: { subscription?: string | { id: string } | null } | null } | null }).parent;
    const legacy = (inv as unknown as { subscription?: string | { id: string } | null }).subscription;
    return idOf(parent?.subscription_details?.subscription ?? legacy ?? null);
}

async function onInvoicePaid(inv: Stripe.Invoice): Promise<boolean> {
    const subId = invoiceSubscriptionId(inv);
    if (!subId) return false;
    const periodEnd = inv.lines?.data?.[0]?.period?.end;
    const res = await db.query(
        "UPDATE subscriptions SET status = CASE WHEN status = 'past_due' THEN 'active' ELSE status END, past_due_since = NULL, current_period_end = GREATEST(COALESCE(current_period_end, 0), $1), updated_at = $2 WHERE id = $3",
        [periodEnd ? periodEnd * 1000 : 0, Date.now(), subId],
    );
    return Number(res.rowCount) > 0;
}

async function onInvoiceFailed(inv: Stripe.Invoice): Promise<boolean> {
    const subId = invoiceSubscriptionId(inv);
    if (!subId) return false;
    const now = Date.now();
    const res = await db.query(
        "UPDATE subscriptions SET status = CASE WHEN status IN ('active', 'trialing') THEN 'past_due' ELSE status END, past_due_since = COALESCE(past_due_since, $1), updated_at = $1 WHERE id = $2",
        [now, subId],
    );
    return Number(res.rowCount) > 0;
}

async function onChargeRefunded(charge: Stripe.Charge): Promise<boolean> {
    const pi = idOf(charge.payment_intent as string | { id: string } | null);
    if (!pi) return false;
    const res = await db.query('SELECT * FROM credit_purchases WHERE payment_intent = $1', [pi]);
    const purchase = res.rows[0] as { user_id: string; credits: unknown; clawed_back: unknown } | undefined;
    if (!purchase) return false; // not a credit pack (subscription refunds arrive as subscription events)
    const ratio = charge.amount > 0 ? Math.min(1, charge.amount_refunded / charge.amount) : 1;
    const target = round6(Number(purchase.credits) * ratio - Number(purchase.clawed_back));
    if (target <= 0) return true;
    const r = await clawbackCredits(purchase.user_id, target, {
        idempotencyKey: `stripe:refund:${charge.id}:${charge.amount_refunded}`,
        reason: `Refund of credit pack (${Math.round(ratio * 100)}%)`,
        extra: async (client) => {
            await client.query('UPDATE credit_purchases SET clawed_back = clawed_back + $1 WHERE payment_intent = $2', [target, pi]);
        },
    });
    log.info({ userId: purchase.user_id, target, removed: r.removed }, 'credits clawed back after refund');
    return true;
}
