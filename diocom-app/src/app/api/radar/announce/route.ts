import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, getLogger } from '@/lib/observability';
import { announcePeer, getNearbyPeers, type RadarPeer } from '@/lib/radarService';

async function handlePOST(request: Request) {
  const limited = await enforceRateLimit(request, 'radar-announce', { maxRequests: 180, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const { id, name, type, platform, avatarColor } = body as Partial<RadarPeer>;

    if (!id || typeof id !== 'string' || id.length > 64) {
      return NextResponse.json({ error: 'Valid peer id required' }, { status: 400 });
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || '127.0.0.1';

    await announcePeer({
      id,
      name: (name && typeof name === 'string') ? name.slice(0, 50) : 'Datran Peer',
      type: (type === 'mobile' || type === 'tablet') ? type : 'desktop',
      platform: typeof platform === 'string' ? platform.slice(0, 30) : undefined,
      avatarColor: typeof avatarColor === 'string' ? avatarColor.slice(0, 20) : undefined,
      ip: clientIp,
    });

    const peers = await getNearbyPeers(id);
    return NextResponse.json({ success: true, peers });
  } catch (err) {
    getLogger().error({ err }, 'radar/announce POST');
    return NextResponse.json({ error: 'Failed to announce radar presence' }, { status: 500 });
  }
}

async function handleGET(request: Request) {
  const { searchParams } = new URL(request.url);
  const excludeId = searchParams.get('excludeId') || undefined;

  try {
    const peers = await getNearbyPeers(excludeId);
    return NextResponse.json({ success: true, peers });
  } catch (err) {
    getLogger().error({ err }, 'radar/announce GET');
    return NextResponse.json({ error: 'Failed to fetch radar peers' }, { status: 500 });
  }
}

export const POST = withObservability(handlePOST, '/api/radar/announce');
export const GET = withObservability(handleGET, '/api/radar/announce');
