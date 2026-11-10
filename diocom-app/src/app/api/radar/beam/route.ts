import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, getLogger } from '@/lib/observability';
import { sendRadarBeam } from '@/lib/radarService';

async function handlePOST(request: Request) {
  const limited = await enforceRateLimit(request, 'radar-beam', { maxRequests: 60, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const { fromPeerId, fromName, toPeerId, toPeerIds, fileIds, fileName, fileSize } = body as {
      fromPeerId?: string;
      fromName?: string;
      toPeerId?: string;
      toPeerIds?: string[];
      fileIds?: string[];
      fileName?: string;
      fileSize?: number;
    };

    const targetList = Array.from(
      new Set([
        ...(toPeerIds || []),
        ...(toPeerId ? [toPeerId] : []),
      ])
    ).filter(Boolean);

    if (!fromPeerId || targetList.length === 0 || !Array.isArray(fileIds) || fileIds.length === 0) {
      return NextResponse.json({ error: 'Missing required beam parameters' }, { status: 400 });
    }

    const beams = await sendRadarBeam({
      fromPeerId,
      fromName: fromName || 'Nearby Peer',
      toPeerIds: targetList,
      fileIds,
      fileName,
      fileSize,
    });

    return NextResponse.json({
      success: true,
      count: beams.length,
      beam: beams[0],
      beams,
    });
  } catch (err) {
    getLogger().error({ err }, 'radar/beam POST');
    return NextResponse.json({ error: 'Failed to dispatch beam' }, { status: 500 });
  }
}

export const POST = withObservability(handlePOST, '/api/radar/beam');
