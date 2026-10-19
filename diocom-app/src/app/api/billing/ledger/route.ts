import { NextResponse } from 'next/server';
import { requireRequestUser } from '@/lib/auth/requestUser';
import { getLedger } from '@/lib/billing/summary';
import { withObservability } from '@/lib/observability';

export const dynamic = 'force-dynamic';

/** GET /api/billing/ledger?limit=50: the user's credit ledger, newest first. */
async function handleGET(req: Request) {
    const user = await requireRequestUser(req);
    if (user instanceof NextResponse) return user;
    const limit = Number(new URL(req.url).searchParams.get('limit')) || 50;
    return NextResponse.json({ success: true, entries: await getLedger(user.id, limit) }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withObservability(handleGET, '/api/billing/ledger');
