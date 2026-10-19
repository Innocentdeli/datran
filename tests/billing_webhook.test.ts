/**
 * Stripe webhooks: signature verification over the raw body (payloads signed with
 * stripe.webhooks.generateTestHeaderString and a test secret), idempotency (processed_events + per-handler keys) and
 * every handled event type. Checkout / portal session creation run against a mocked Stripe API. Dev JSON store.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installAppAlias, APP_DIR } from './helpers/dbScenario';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diocom-webhook-'));
const SECRET = 'whsec_test_secret_for_unit_tests';
Object.assign(process.env, {
    NODE_ENV: 'test', LOCAL_DB_PATH: path.join(tmp, 'db.json'), DIOCOM_SECRET: 'x', LOG_LEVEL: 'silent',
    STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRICE_PRO_MONTHLY: 'price_pro_m', STRIPE_PRICE_PRO_YEARLY: 'price_pro_y', STRIPE_PRICE_CREDITS_100: 'price_c100',
    BILLING_GRACE_DAYS: '7',
});
delete process.env.DATABASE_URL;
installAppAlias();

/* eslint-disable @typescript-eslint/no-require-imports */
const SRC = path.join(APP_DIR, 'src');
const Stripe = require(path.join(APP_DIR, 'node_modules', 'stripe'));
const wh = require(path.join(SRC, 'lib', 'billing', 'webhook.ts'));
const st = require(path.join(SRC, 'lib', 'billing', 'stripe.ts'));
const ent = require(path.join(SRC, 'lib', 'billing', 'entitlement.ts'));
const credits = require(path.join(SRC, 'lib', 'billing', 'credits.ts'));
const db = require(path.join(SRC, 'db', 'index.ts')).default;
/* eslint-enable @typescript-eslint/no-require-imports */

type Call = { method: string; args: unknown[] };
const calls: Call[] = [];
const subscriptions = new Map<string, Record<string, unknown>>();
const mock = {
    customers: { create: async (...args: unknown[]) => { calls.push({ method: 'customers.create', args }); return { id: `cus_${randomUUID().slice(0, 8)}` }; } },
    subscriptions: { retrieve: async (id: string) => { calls.push({ method: 'subscriptions.retrieve', args: [id] }); return subscriptions.get(id); } },
    checkout: { sessions: { create: async (p: unknown) => { calls.push({ method: 'checkout.sessions.create', args: [p] }); return { id: 'cs_new', url: 'https://checkout.stripe.test/cs_new' }; } } },
    billingPortal: { sessions: { create: async (p: unknown) => { calls.push({ method: 'billingPortal.sessions.create', args: [p] }); return { url: 'https://billing.stripe.test/p' }; } } },
};

let seq = 0;
function event(type: string, object: Record<string, unknown>, createdSec = Math.floor(Date.now() / 1000) + seq) {
    seq++;
    return { id: `evt_${randomUUID().replace(/-/g, '')}`, object: 'event', type, created: createdSec, data: { object }, api_version: '2026-09-30', livemode: false };
}
function sign(payload: string, secret = SECRET) {
    return Stripe.webhooks.generateTestHeaderString({ payload, secret });
}
async function deliver(evt: unknown) {
    const payload = JSON.stringify(evt);
    return wh.handleStripeWebhook(Buffer.from(payload), sign(payload), { stripe: mock });
}
async function newUser(): Promise<string> {
    const id = randomUUID();
    await db.query('INSERT INTO users (id, name, email, password_hash, image, provider, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, 'W', `${id}@w.io`, null, '', 'credentials', 'user', Date.now()]);
    return id;
}
function sub(id: string, userId: string, status: string, extra: Record<string, unknown> = {}) {
    return {
        id, object: 'subscription', status, customer: 'cus_sub', cancel_at_period_end: false, metadata: { userId },
        items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400, price: { id: 'price_pro_m', recurring: { interval: 'month' } } }] },
        ...extra,
    };
}

before(() => st.setStripeForTesting(mock));
after(() => { st.setStripeForTesting(undefined); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('signature verification', () => {
    test('valid signature accepted; bad / missing / wrong secret / tampered body rejected', async () => {
        const evt = event('ping.unknown', { id: 'x' });
        const payload = JSON.stringify(evt);
        assert.equal((await wh.handleStripeWebhook(Buffer.from(payload), sign(payload), { stripe: mock })).status, 200);
        assert.equal((await wh.handleStripeWebhook(Buffer.from(payload), null, { stripe: mock })).status, 400);
        assert.equal((await wh.handleStripeWebhook(Buffer.from(payload), sign(payload, 'whsec_other'), { stripe: mock })).status, 400);
        const tampered = payload.replace('ping.unknown', 'checkout.session.completed');
        assert.equal((await wh.handleStripeWebhook(Buffer.from(tampered), sign(payload), { stripe: mock })).status, 400);
        const old = Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 });
        assert.equal((await wh.handleStripeWebhook(Buffer.from(payload), old, { stripe: mock })).status, 400, 'replayed old signature (tolerance)');
        assert.equal((await wh.handleStripeWebhook(Buffer.from(payload), sign(payload), { stripe: null })).status, 503, 'billing not configured');
    });

    test('unknown event types are acknowledged as ignored', async () => {
        const r = await deliver(event('customer.created', { id: 'cus_1' }));
        assert.deepEqual(r, { status: 200, body: { received: true, outcome: 'ignored' } });
    });
});

describe('credit packs', () => {
    test('checkout.session.completed grants credits once; redelivery and a second event for the same session are no-ops', async () => {
        const u = await newUser();
        const session = { id: `cs_${randomUUID().slice(0, 8)}`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', customer: 'cus_pack',
            client_reference_id: u, metadata: { userId: u, kind: 'credits', credits: '100' }, payment_intent: `pi_${randomUUID().slice(0, 8)}`, amount_total: 1000 };
        const evt = event('checkout.session.completed', session);
        assert.equal((await deliver(evt)).body.outcome, 'processed');
        assert.equal(await credits.getBalance(u), 100);
        assert.equal((await deliver(evt)).body.outcome, 'duplicate', 'same event id');
        assert.equal((await deliver(event('checkout.session.async_payment_succeeded', session))).body.outcome, 'processed');
        assert.equal(await credits.getBalance(u), 100, 'idempotency key per checkout session');
        const users = await db.query('SELECT * FROM users WHERE id = $1', [u]);
        assert.equal(users.rows[0].stripe_customer_id, 'cus_pack', 'customer linked');
        const ledger = await credits.listLedger(u);
        assert.equal(ledger.length, 1);
        assert.equal(ledger[0].type, 'purchase');
    });

    test('unpaid (async) sessions grant nothing until paid', async () => {
        const u = await newUser();
        const r = await deliver(event('checkout.session.completed', { id: 'cs_async', mode: 'payment', payment_status: 'unpaid', metadata: { userId: u, kind: 'credits', credits: '100' }, payment_intent: 'pi_async' }));
        assert.equal(r.body.outcome, 'ignored');
        assert.equal(await credits.getBalance(u), 0);
    });

    test('charge.refunded claws back only unused credits, proportionally, once', async () => {
        const u = await newUser();
        const pi = `pi_${randomUUID().slice(0, 8)}`;
        await deliver(event('checkout.session.completed', { id: `cs_${pi}`, mode: 'payment', payment_status: 'paid', metadata: { userId: u, kind: 'credits', credits: '100' }, payment_intent: pi, amount_total: 1000 }));
        assert.equal(await credits.debitCredits(u, 80, { type: 'spend' }).then((r: { ok: boolean }) => r.ok), true);
        const charge = { id: `ch_${pi}`, object: 'charge', payment_intent: pi, amount: 1000, amount_refunded: 500, refunded: false };
        const half = event('charge.refunded', charge);
        assert.equal((await deliver(half)).body.outcome, 'processed');
        assert.equal(await credits.getBalance(u), 0, '50 requested, only 20 unused credits remained');
        await deliver(half);
        await credits.grantCredits(u, 10, { type: 'grant' });
        // Full refund later: the remaining 50 credits of the pack are targeted, 10 available.
        await deliver(event('charge.refunded', { ...charge, amount_refunded: 1000, refunded: true }));
        assert.equal(await credits.getBalance(u), 0);
        const purchase = await db.query('SELECT * FROM credit_purchases WHERE payment_intent = $1', [pi]);
        assert.equal(Number(purchase.rows[0].clawed_back), 100);
        const claw = (await credits.listLedger(u)).filter((e: { type: string }) => e.type === 'refund_clawback');
        assert.deepEqual(claw.map((e: { amount: number }) => e.amount).sort(), [-10, -20]);
    });

    test('refund of a non-credit charge is ignored', async () => {
        const r = await deliver(event('charge.refunded', { id: 'ch_x', payment_intent: 'pi_unknown', amount: 100, amount_refunded: 100 }));
        assert.equal(r.body.outcome, 'ignored');
    });
});

describe('subscriptions and entitlement', () => {
    test('checkout (subscription) -> Pro; past_due within grace stays Pro; invoice.paid clears; deleted -> Free', async () => {
        const u = await newUser();
        assert.equal(await ent.getUserPlanId(u), 'free');
        const subId = `sub_${randomUUID().slice(0, 8)}`;
        subscriptions.set(subId, sub(subId, u, 'active'));
        const r = await deliver(event('checkout.session.completed', { id: `cs_${subId}`, mode: 'subscription', payment_status: 'paid', client_reference_id: u, metadata: { userId: u, kind: 'pro' }, customer: 'cus_sub', subscription: subId }));
        assert.equal(r.body.outcome, 'processed');
        assert.ok(calls.some((c) => c.method === 'subscriptions.retrieve' && c.args[0] === subId), 'state fetched from Stripe, not the client');
        assert.equal(await ent.getUserPlanId(u), 'pro');
        const s1 = (await ent.listSubscriptions(u))[0];
        assert.equal(s1.billing_interval, 'month');
        assert.ok(s1.current_period_end > Date.now());

        await deliver(event('invoice.payment_failed', { id: 'in_1', parent: { subscription_details: { subscription: subId } } }));
        let s = (await ent.listSubscriptions(u))[0];
        assert.equal(s.status, 'past_due');
        assert.ok(s.past_due_since);
        assert.equal(await ent.getUserPlanId(u), 'pro', 'grace period');
        assert.equal(ent.isEntitled(s, s.past_due_since + 8 * 86_400_000), false, 'after 7 days of grace -> Free');

        await deliver(event('invoice.paid', { id: 'in_2', parent: { subscription_details: { subscription: subId } }, lines: { data: [{ period: { end: Math.floor(Date.now() / 1000) + 60 * 86400 } }] } }));
        s = (await ent.listSubscriptions(u))[0];
        assert.equal(s.status, 'active');
        assert.equal(s.past_due_since, null);

        await deliver(event('customer.subscription.deleted', sub(subId, u, 'canceled')));
        assert.equal(await ent.getUserPlanId(u), 'free');
    });

    test('created/updated events map users by metadata or customer id; stale events are ignored', async () => {
        const u = await newUser();
        await db.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL', ['cus_map', u]);
        const subId = `sub_${randomUUID().slice(0, 8)}`;
        const now = Math.floor(Date.now() / 1000);
        await deliver(event('customer.subscription.created', sub(subId, '', 'trialing', { customer: 'cus_map', metadata: {} }), now + 100));
        assert.equal(await ent.getUserPlanId(u), 'pro', 'trialing via customer id');
        await deliver(event('customer.subscription.updated', sub(subId, u, 'canceled'), now + 50)); // older than the applied state
        assert.equal((await ent.listSubscriptions(u))[0].status, 'trialing', 'stale event ignored');
        await deliver(event('customer.subscription.updated', sub(subId, u, 'past_due'), now + 200));
        assert.equal((await ent.listSubscriptions(u))[0].status, 'past_due');
        await deliver(event('customer.subscription.updated', sub(subId, u, 'unpaid'), now + 300));
        assert.equal(await ent.getUserPlanId(u), 'free');
    });

    test('unknown users are ignored, not crashed on', async () => {
        const r = await deliver(event('customer.subscription.updated', sub('sub_ghost', 'nope', 'active', { customer: 'cus_ghost' })));
        assert.equal(r.status, 200);
        assert.equal(r.body.outcome, 'ignored');
    });

    test('without STRIPE_SECRET_KEY everyone is Free', async () => {
        const u = await newUser();
        await deliver(event('customer.subscription.created', sub(`sub_${randomUUID().slice(0, 6)}`, u, 'active')));
        delete process.env.STRIPE_SECRET_KEY;
        try {
            assert.equal(await ent.getUserPlanId(u), 'free');
            assert.equal(st.billingStatus().configured, false);
        } finally {
            process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
        }
        assert.equal(await ent.getUserPlanId(u), 'pro');
    });
});

describe('checkout and portal sessions (mocked Stripe API)', () => {
    test('Pro checkout creates the customer once and puts userId into metadata', async () => {
        const u = await newUser();
        calls.length = 0;
        const url = await st.createCheckoutSession({ id: u }, { kind: 'pro', interval: 'year' }, 'http://localhost:3000');
        assert.equal(url, 'https://checkout.stripe.test/cs_new');
        const p = calls.find((c) => c.method === 'checkout.sessions.create')!.args[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.equal(p.mode, 'subscription');
        assert.deepEqual(p.line_items, [{ price: 'price_pro_y', quantity: 1 }]);
        assert.equal(p.client_reference_id, u);
        assert.equal(p.subscription_data.metadata.userId, u);
        assert.match(p.success_url, /\/billing\?checkout=success/);
        await st.createCheckoutSession({ id: u }, { kind: 'credits', credits: 100 }, 'http://localhost:3000');
        assert.equal(calls.filter((c) => c.method === 'customers.create').length, 1, 'customer reused');
        const p2 = calls.filter((c) => c.method === 'checkout.sessions.create')[1].args[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        assert.equal(p2.mode, 'payment');
        assert.equal(p2.payment_intent_data.metadata.credits, '100');
        await assert.rejects(st.createCheckoutSession({ id: u }, { kind: 'credits', credits: 7 }, 'http://x'), /Unknown credit pack/);
        assert.equal(await st.createPortalSession({ id: u }, 'http://localhost:3000'), 'https://billing.stripe.test/p');
    });

    test('already Pro -> 409; no customer yet -> portal 400; not configured -> 503', async () => {
        const u = await newUser();
        await deliver(event('customer.subscription.created', sub(`sub_${randomUUID().slice(0, 6)}`, u, 'active')));
        await assert.rejects(st.createCheckoutSession({ id: u }, { kind: 'pro', interval: 'month' }, 'http://x'), (e: { status: number }) => e.status === 409);
        const v = await newUser();
        await assert.rejects(st.createPortalSession({ id: v }, 'http://x'), (e: { status: number }) => e.status === 400);
        st.setStripeForTesting(null);
        try {
            await assert.rejects(st.createCheckoutSession({ id: v }, { kind: 'credits', credits: 100 }, 'http://x'), (e: { status: number }) => e.status === 503);
        } finally {
            st.setStripeForTesting(mock);
        }
    });
});
