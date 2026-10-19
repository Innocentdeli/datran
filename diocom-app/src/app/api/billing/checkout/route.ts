import { NextResponse } from 'next/server';
import { requireRequestUser } from '@/lib/auth/requestUser';
import { enforceRateLimit } from '@/lib/rateLimit';
import { BillingError, createCheckoutSession, type CheckoutRequest } from '@/lib/billing/stripe';
import { withObservability, getLogger } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/checkout  { kind: 'pro', interval: 'month' | 'year' } | { kind: 'credits', credits: <pack size> }
 * -> { url } of a Stripe Checkout Session. Nothing is granted here: entitlement/credits come from the webhook.
 */
async function handlePOST(req: Request) {
    const user = await requireRequestUser(req);
    if (user instanceof NextResponse) return user;
    const limited = await enforceRateLimit(req, 'billing-checkout', { maxRequests: 10, windowMs: 60_000 }, user.id);
    if (limited) return limited;

    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 });
    }
    let request: CheckoutRequest;
    if (body.kind === 'pro' && (body.interval === 'month' || body.interval === 'year')) {
        request = { kind: 'pro', interval: body.interval };
    } else if (body.kind === 'credits' && Number.isFinite(Number(body.credits))) {
        request = { kind: 'credits', credits: Number(body.credits) };
    } else {
        return NextResponse.json({ success: false, error: 'Expected { kind: "pro", interval } or { kind: "credits", credits }' }, { status: 400 });
    }

    try {
        const url = await createCheckoutSession({ id: user.id }, request, new URL(req.url).origin);
        return NextResponse.json({ success: true, url });
    } catch (e) {
        if (e instanceof BillingError) return NextResponse.json({ success: false, error: e.message, code: e.code }, { status: e.status });
        getLogger().error({ err: e }, 'checkout session failed');
        return NextResponse.json({ success: false, error: 'Could not start checkout. Please try again.' }, { status: 502 });
    }
}

export const POST = withObservability(handlePOST, '/api/billing/checkout');
