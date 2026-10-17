import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { getClusterPredictionStatus } from '@/lib/prefetcher';

/** Admin-only: access prediction & prefetch status and measured metrics (NETWORK_SPEC §5). */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if ((session.user as { role?: string }).role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    try {
        return NextResponse.json(await getClusterPredictionStatus(), { headers: { 'Cache-Control': 'no-store' } });
    } catch (e) {
        console.error('[admin/prediction]', e);
        return NextResponse.json({ error: 'Failed to load prediction status' }, { status: 500 });
    }
}
