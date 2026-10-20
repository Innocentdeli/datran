import { NextResponse } from 'next/server';
import { AnalyticsService } from '@/lib/analytics';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { LedgerService } from '@/lib/ledger';
import { withObservability, getLogger } from '@/lib/observability';

async function handleGET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if ((session.user as { role?: string }).role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    try {
        const stats = { ...(await AnalyticsService.getStats()), ledgerBlocks: await LedgerService.getRecentBlocks(20) };
        return NextResponse.json(stats);
    } catch (e) {
        getLogger().error({ err: e }, 'admin/stats');
        return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 });
    }
}

export const GET = withObservability(handleGET, '/api/admin/stats');
