import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { getReactorUrl } from '@/lib/reactorWorker';

const STATUS_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Admin-only proxy for the Rust reactor's GET /evolution/status (EVOLUTION_SPEC §5). */
export async function GET() {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if ((session.user as { role?: string }).role !== 'admin') {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (process.env.REACTOR_TOKEN) headers['x-reactor-token'] = process.env.REACTOR_TOKEN;

    let res: Response;
    try {
        res = await fetch(`${getReactorUrl()}/evolution/status`, {
            headers,
            cache: 'no-store',
            signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
    } catch (e) {
        console.warn('[admin/evolution] Reactor unreachable:', e instanceof Error ? e.message : e);
        return NextResponse.json({ error: 'Reactor offline' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }

    if (!res.ok) {
        console.warn(`[admin/evolution] Reactor /evolution/status returned ${res.status}`);
        return NextResponse.json(
            { error: `Reactor returned ${res.status}` },
            { status: 503, headers: { 'Cache-Control': 'no-store' } }
        );
    }

    try {
        const text = await res.text();
        if (text.length > MAX_BODY_BYTES) throw new Error('response too large');
        return NextResponse.json(JSON.parse(text), { headers: { 'Cache-Control': 'no-store' } });
    } catch (e) {
        console.warn('[admin/evolution] Invalid status payload:', e instanceof Error ? e.message : e);
        return NextResponse.json({ error: 'Invalid reactor response' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
}
