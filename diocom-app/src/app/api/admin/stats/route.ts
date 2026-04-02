import { NextResponse } from 'next/server';
import { AnalyticsService } from '@/lib/analytics';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { LedgerService } from '@/lib/ledger';

export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user || (session.user as any).role !== 'admin') {
        return new NextResponse('Unauthorized', { status: 401 });
    }

    // In real app, check for admin role
    const stats: any = await AnalyticsService.getStats();
    stats.ledgerBlocks = await LedgerService.getRecentBlocks(20);

    return NextResponse.json(stats);
}
