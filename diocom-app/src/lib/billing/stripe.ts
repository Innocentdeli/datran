import Stripe from 'stripe';
import db from '@/db';
import { createModuleLogger } from '../observability/logger';
import { billingConfigured, getUserPlanId } from './entitlement';

const log = createModuleLogger('billing');

/**
 * Stripe client + Checkout / Customer Portal sessions (official `stripe` package; use TEST-mode keys outside prod).
 *
 * Env:
 *   STRIPE_SECRET_KEY            sk_test_... / sk_live_... (unset: billing "not configured", everyone is Free)
 *   STRIPE_WEBHOOK_SECRET        whsec_... for POST /api/billing/webhook
 *   STRIPE_PRICE_PRO_MONTHLY     price id of the Pro monthly subscription
 *   STRIPE_PRICE_PRO_YEARLY      price id of the Pro yearly subscription
 *   STRIPE_PRICE_CREDITS_<N>     one-time price id of a pack of N credits (e.g. STRIPE_PRICE_CREDITS_100=price_...)
 *   STRIPE_CREDIT_PACKS          alternative list form: "100:price_abc,500:price_def"
 *   APP_URL / NEXTAUTH_URL       origin for success/cancel/return URLs (default: the request origin)
 *
 * Entitlements and credits are granted ONLY by the signed webhook (src/lib/billing/webhook.ts), never by the
 * success redirect.
 */

const g = globalThis as typeof globalThis & { __diocomStripe?: Stripe | null; __diocomStripeKey?: string };

export function getStripe(): Stripe | null {
    const key = process.env.STRIPE_SECRET_KEY;
    if (g.__diocomStripe !== undefined && (g.__diocomStripeKey === key || g.__diocomStripeKey === '__test__')) return g.__diocomStripe;
    g.__diocomStripe = key ? new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: 'diocom-app' } }) : null;
    g.__diocomStripeKey = key;
    return g.__diocomStripe;
}

/** Test hook: inject a mock client (or undefined to go back to the env-configured one). */
export function setStripeForTesting(client: unknown): void {
    if (client === undefined) {
        delete g.__diocomStripe;
        delete g.__diocomStripeKey;
        return;
    }
    g.__diocomStripe = client as Stripe | null;
    g.__diocomStripeKey = '__test__';
}

export interface CreditPack {
    credits: number;
    priceId: string;
}

export function creditPacks(): CreditPack[] {
    const packs = new Map<number, string>();
    for (const part of (process.env.STRIPE_CREDIT_PACKS || '').split(',')) {
        const m = /^\s*(\d+(?:\.\d+)?)\s*:\s*(\S+)\s*$/.exec(part);
        if (m) packs.set(Number(m[1]), m[2]);
    }
    for (const [k, v] of Object.entries(process.env)) {
        const m = /^STRIPE_PRICE_CREDITS_(\d+)$/.exec(k);
        if (m && v) packs.set(Number(m[1]), v.trim());
    }
    return [...packs].filter(([c]) => c > 0).map(([credits, priceId]) => ({ credits, priceId })).sort((a, b) => a.credits - b.credits);
}

export function proPrices(): { month: string | null; year: string | null } {
    return { month: process.env.STRIPE_PRICE_PRO_MONTHLY || null, year: process.env.STRIPE_PRICE_PRO_YEARLY || null };
}

export function intervalForPrice(priceId: string | null | undefined): 'month' | 'year' | null {
    const p = proPrices();
    if (priceId && priceId === p.month) return 'month';
    if (priceId && priceId === p.year) return 'year';
    return null;
}

export interface BillingStatus {
    configured: boolean;
    webhookConfigured: boolean;
    proMonthly: boolean;
    proYearly: boolean;
    creditPacks: number[];
}

export function billingStatus(): BillingStatus {
    const p = proPrices();
    return {
        configured: billingConfigured(),
        webhookConfigured: !!process.env.STRIPE_WEBHOOK_SECRET,
        proMonthly: !!p.month,
        proYearly: !!p.year,
        creditPacks: creditPacks().map((c) => c.credits),
    };
}

export class BillingError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) {
        super(message);
        this.name = 'BillingError';
    }
}

function requireStripe(): Stripe {
    const s = getStripe();
    if (!s) throw new BillingError('Billing is not configured on this server.', 503, 'BILLING_NOT_CONFIGURED');
    return s;
}

/** Base URL for redirects: APP_URL / NEXTAUTH_URL, else the request origin. */
export function appOrigin(requestOrigin: string): string {
    const configured = process.env.APP_URL || process.env.NEXTAUTH_URL;
    try {
        return configured ? new URL(configured).origin : requestOrigin;
    } catch {
        return requestOrigin;
    }
}

interface BillingUser {
    id: string;
    email?: string | null;
    name?: string | null;
}

/** The user's Stripe customer id, creating the customer once (idempotent across concurrent requests). */
export async function ensureStripeCustomer(user: BillingUser, stripe: Stripe = requireStripe()): Promise<string> {
    const cur = await db.query('SELECT * FROM users WHERE id = $1', [user.id]);
    const row = cur.rows[0] as { stripe_customer_id?: string | null; email?: string | null; name?: string | null } | undefined;
    if (!row) throw new BillingError('Unknown user.', 404, 'USER_NOT_FOUND');
    if (row.stripe_customer_id) return row.stripe_customer_id;
    const customer = await stripe.customers.create(
        { email: row.email ?? user.email ?? undefined, name: row.name ?? user.name ?? undefined, metadata: { userId: user.id } },
        { idempotencyKey: `diocom-customer-${user.id}` },
    );
    await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', [customer.id, user.id]);
    const again = await db.query('SELECT * FROM users WHERE id = $1', [user.id]);
    return (again.rows[0] as { stripe_customer_id?: string | null })?.stripe_customer_id || customer.id;
}

export type CheckoutRequest = { kind: 'pro'; interval: 'month' | 'year' } | { kind: 'credits'; credits: number };

/** Creates a hosted Checkout Session and returns its URL. */
export async function createCheckoutSession(user: BillingUser, req: CheckoutRequest, requestOrigin: string): Promise<string> {
    const stripe = requireStripe();
    const origin = appOrigin(requestOrigin);
    const base = {
        client_reference_id: user.id,
        success_url: `${origin}/billing?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/billing?checkout=cancelled`,
    };
    let params: Stripe.Checkout.SessionCreateParams;
    if (req.kind === 'pro') {
        const price = proPrices()[req.interval];
        if (!price) throw new BillingError(`The Pro ${req.interval === 'month' ? 'monthly' : 'yearly'} plan is not available.`, 400, 'PRICE_NOT_CONFIGURED');
        if ((await getUserPlanId(user.id)) === 'pro') {
            throw new BillingError('You already have Pro. Use "Manage subscription" to change it.', 409, 'ALREADY_SUBSCRIBED');
        }
        params = {
            ...base,
            mode: 'subscription',
            customer: await ensureStripeCustomer(user, stripe),
            line_items: [{ price, quantity: 1 }],
            allow_promotion_codes: true,
            metadata: { userId: user.id, kind: 'pro', interval: req.interval },
            subscription_data: { metadata: { userId: user.id } },
        };
    } else {
        const pack = creditPacks().find((p) => p.credits === req.credits);
        if (!pack) throw new BillingError('Unknown credit pack.', 400, 'UNKNOWN_PACK');
        const meta = { userId: user.id, kind: 'credits', credits: String(pack.credits) };
        params = {
            ...base,
            mode: 'payment',
            customer: await ensureStripeCustomer(user, stripe),
            line_items: [{ price: pack.priceId, quantity: 1 }],
            metadata: meta,
            payment_intent_data: { metadata: meta },
        };
    }
    const session = await stripe.checkout.sessions.create(params);
    if (!session.url) throw new BillingError('Stripe did not return a checkout URL.', 502, 'STRIPE_ERROR');
    log.info({ userId: user.id, kind: req.kind }, 'checkout session created');
    return session.url;
}

/** Customer Portal session (manage / cancel subscription, payment methods, invoices). */
export async function createPortalSession(user: BillingUser, requestOrigin: string): Promise<string> {
    const stripe = requireStripe();
    const res = await db.query('SELECT * FROM users WHERE id = $1', [user.id]);
    const customer = (res.rows[0] as { stripe_customer_id?: string | null } | undefined)?.stripe_customer_id;
    if (!customer) throw new BillingError('No billing account yet: subscribe or buy credits first.', 400, 'NO_CUSTOMER');
    const session = await stripe.billingPortal.sessions.create({ customer, return_url: `${appOrigin(requestOrigin)}/billing` });
    return session.url;
}
