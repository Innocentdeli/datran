import { NextResponse } from 'next/server';
import { requireRequestUser } from '@/lib/auth/requestUser';
import { getBillingSummary } from '@/lib/billing/summary';
import { withObservability } from '@/lib/observability';

export const dynamic = 'force-dynamic';

/** GET /api/billing/usage: plan, usage (storage, monthly egress, uploads), credit balance, subscription. Cookie or bearer. */
async function handleGET(req: Request) {
    const user = await requireRequestUser(req);
    if (user instanceof NextResponse) return user;
    return NextResponse.json({ success: true, ...(await getBillingSummary(user.id)) }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withObservability(handleGET, '/api/billing/usage');
