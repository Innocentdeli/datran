import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, getLogger } from '@/lib/observability';
import { getPendingRadarBeams, respondToRadarBeam } from '@/lib/radarService';

async function handleGET(request: Request) {
  const { searchParams } = new URL(request.url);
  const peerId = searchParams.get('peerId');

  if (!peerId) {
    return NextResponse.json({ error: 'peerId is required' }, { status: 400 });
  }

  try {
    const beams = await getPendingRadarBeams(peerId);
    return NextResponse.json({ success: true, beams });
  } catch (err) {
    getLogger().error({ err }, 'radar/inbox GET');
    return NextResponse.json({ error: 'Failed to fetch inbox' }, { status: 500 });
  }
}

async function handlePOST(request: Request) {
  const limited = await enforceRateLimit(request, 'radar-inbox-respond', { maxRequests: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const { beamId, peerId, accept } = body as {
      beamId?: string;
      peerId?: string;
      accept?: boolean;
    };

    if (!beamId || !peerId || typeof accept !== 'boolean') {
      return NextResponse.json({ error: 'beamId, peerId, and accept boolean are required' }, { status: 400 });
    }

    const updated = await respondToRadarBeam(beamId, peerId, accept);
    if (!updated) {
      return NextResponse.json({ error: 'Beam not found or expired' }, { status: 404 });
    }

    return NextResponse.json({ success: true, beam: updated });
  } catch (err) {
    getLogger().error({ err }, 'radar/inbox POST');
    return NextResponse.json({ error: 'Failed to respond to beam' }, { status: 500 });
  }
}

export const GET = withObservability(handleGET, '/api/radar/inbox');
export const POST = withObservability(handlePOST, '/api/radar/inbox');
