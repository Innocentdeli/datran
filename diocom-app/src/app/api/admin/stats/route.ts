import { NextResponse } from 'next/server';
import { AnalyticsService } from '@/lib/analytics';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { LedgerService } from '@/lib/ledger';

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if ((session.user as { role?: string }).role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stats: any = await AnalyticsService.getStats();
        stats.ledgerBlocks = await LedgerService.getRecentBlocks(20);
        return NextResponse.json(stats);
    } catch (e) {
        console.error('[admin/stats]', e);
        return NextResponse.json({ error: 'Failed to load stats' }, { status: 500 });
    }
}
