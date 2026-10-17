import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { SwarmNodeRepository } from '@/db/files';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getClientIp } from '@/lib/security';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!userId) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const limited = enforceRateLimit(request, 'swarm-pulse', { maxRequests: 30, windowMs: 60_000 }, userId);
    if (limited) return limited;

    try {
        const { nodeId, region } = await request.json();
        if (typeof nodeId !== 'string' || !ID_RE.test(nodeId)) {
            return NextResponse.json({ success: false }, { status: 400 });
        }
        const safeRegion = typeof region === 'string' && /^[A-Za-z0-9 _-]{1,32}$/.test(region) ? region : 'unknown';

        await SwarmNodeRepository.pulse(nodeId, safeRegion, getClientIp(request));

        const activeNodes = await SwarmNodeRepository.getActive();
        return NextResponse.json({ success: true, activeNodes: activeNodes.length });
    } catch (error) {
        console.error('[swarm/pulse]', error);
        return NextResponse.json({ success: false }, { status: 500 });
    }
}
