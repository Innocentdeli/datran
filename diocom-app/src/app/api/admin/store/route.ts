import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { getReactorJson } from '@/lib/storage/reactorStore';
import { getStorageBackend } from '@/lib/storage';
import { withObservability, getLogger } from '@/lib/observability';

const NO_STORE = { 'Cache-Control': 'no-store' };

type Part = { status: 'ok'; data: unknown } | { status: 'unavailable' | 'error'; error: string };

async function fetchPart(path: string): Promise<Part> {
    try {
        const { status, body } = await getReactorJson(path);
        if (status >= 200 && status < 300 && body && typeof body === 'object') return { status: 'ok', data: body };
        // 404: endpoint not built into this reactor (e.g. /cluster/status); 503: store disabled.
        if (status === 404 || status === 503) {
            const msg = body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
                ? (body as { error: string }).error : `HTTP ${status}`;
            return { status: 'unavailable', error: msg };
        }
        return { status: 'error', error: `HTTP ${status}` };
    } catch (e) {
        return { status: 'error', error: e instanceof Error ? e.message : String(e) };
    }
}

/**
 * Admin-only proxy for the reactor object store's GET /store/stats and (when the reactor has it) GET /cluster/status
 * (NETWORK_SPEC §2/§4). 503 only when the reactor is unreachable; a missing /cluster/status is reported, not fatal.
 */
async function handleGET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if ((session.user as { role?: string }).role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const [store, cluster] = await Promise.all([fetchPart('/store/stats'), fetchPart('/cluster/status')]);
    const backend = getStorageBackend();
    if (store.status === 'error' && cluster.status === 'error') {
        getLogger().warn({ err: store.error }, 'admin/store Reactor unreachable');
        return NextResponse.json({ error: 'Reactor offline', backend }, { status: 503, headers: NO_STORE });
    }
    return NextResponse.json({ backend, store, cluster }, { headers: NO_STORE });
}

export const GET = withObservability(handleGET, '/api/admin/store');
