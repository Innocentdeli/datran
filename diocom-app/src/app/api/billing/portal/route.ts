import { NextResponse } from 'next/server';
import { requireRequestUser } from '@/lib/auth/requestUser';
import { enforceRateLimit } from '@/lib/rateLimit';
import { BillingError, createPortalSession } from '@/lib/billing/stripe';
import { withObservability, getLogger } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/billing/portal -> { url } of a Stripe Customer Portal session (manage/cancel subscription). */
async function handlePOST(req: Request) {
    const user = await requireRequestUser(req);
    if (user instanceof NextResponse) return user;
    const limited = await enforceRateLimit(req, 'billing-portal', { maxRequests: 10, windowMs: 60_000 }, user.id);
    if (limited) return limited;
    try {
        return NextResponse.json({ success: true, url: await createPortalSession({ id: user.id }, new URL(req.url).origin) });
    } catch (e) {
        if (e instanceof BillingError) return NextResponse.json({ success: false, error: e.message, code: e.code }, { status: e.status });
        getLogger().error({ err: e }, 'portal session failed');
        return NextResponse.json({ success: false, error: 'Could not open the billing portal. Please try again.' }, { status: 502 });
    }
}

export const POST = withObservability(handlePOST, '/api/billing/portal');
