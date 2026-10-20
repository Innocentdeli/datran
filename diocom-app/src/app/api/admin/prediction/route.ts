import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { getClusterPredictionStatus } from '@/lib/prefetcher';
import { withObservability, getLogger } from '@/lib/observability';

/** Admin-only: access prediction & prefetch status and measured metrics (NETWORK_SPEC §5). */
async function handleGET() {
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
        getLogger().error({ err: e }, 'admin/prediction');
        return NextResponse.json({ error: 'Failed to load prediction status' }, { status: 500 });
    }
}

export const GET = withObservability(handleGET, '/api/admin/prediction');
