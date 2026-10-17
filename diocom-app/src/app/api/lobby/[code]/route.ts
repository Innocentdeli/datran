import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import db from '@/db';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getLobbyRole, setLobbyRoleCookie } from '../_shared';

const CODE_RE = /^[A-Z0-9]{4,12}$/;
// Codes are short, so lookups are rate limited to prevent enumeration
const LOOKUP_LIMIT = { maxRequests: 60, windowMs: 60_000 };

// GET /api/lobby/[code] — poll lobby state
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const limited = enforceRateLimit(req, 'lobby-get', LOOKUP_LIMIT);
  if (limited) return limited;

  try {
    const { code } = await params;
    if (!CODE_RE.test(code)) return NextResponse.json({ error: 'Lobby not found' }, { status: 404 });
    const res = await db.query('SELECT * FROM lobby_sessions WHERE code = $1', [code]);
    const lobby = res.rows[0];
    if (!lobby) return NextResponse.json({ error: 'Lobby not found' }, { status: 404 });
    if (Number(lobby.expires_at) < Date.now()) return NextResponse.json({ status: 'expired' });

    // User ids are not exposed
    return NextResponse.json({
      status: lobby.status,
      code: lobby.code,
      expiresAt: lobby.expires_at,
    });
  } catch (e) {
    console.error('[lobby GET]', e);
    return NextResponse.json({ error: 'Failed to load lobby' }, { status: 500 });
  }
}

// PATCH /api/lobby/[code] — join or update lobby
export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const limited = enforceRateLimit(request, 'lobby-patch', { maxRequests: 20, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const { code: lobbyCode } = await params;
    if (!CODE_RE.test(lobbyCode)) return NextResponse.json({ error: 'Lobby not found' }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const action = (body as { action?: unknown }).action;

    const res = await db.query('SELECT * FROM lobby_sessions WHERE code = $1', [lobbyCode]);
    const lobby = res.rows[0];
    if (!lobby) return NextResponse.json({ error: 'Lobby not found' }, { status: 404 });
    if (Number(lobby.expires_at) < Date.now()) {
      return NextResponse.json({ error: 'Lobby expired' }, { status: 410 });
    }

    if (action === 'join') {
      if (lobby.status !== 'waiting') {
        return NextResponse.json({ error: 'Lobby is no longer waiting' }, { status: 400 });
      }
      const session = await getServerSession(authOptions);
      const joinerId = (session?.user as { id?: string } | undefined)?.id || null;
      await db.query('UPDATE lobby_sessions SET joiner_id = $1, status = $2 WHERE code = $3',
        [joinerId, 'active', lobbyCode]);

      const out = NextResponse.json({ success: true, status: 'active' });
      setLobbyRoleCookie(out, lobby.id, 'joiner');
      return out;
    }

    if (action === 'complete') {
      // Only lobby participants (creator or joiner) may complete it
      const role = await getLobbyRole(lobby.id);
      if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      if (lobby.status !== 'active') {
        return NextResponse.json({ error: 'Lobby is not active' }, { status: 400 });
      }
      await db.query("UPDATE lobby_sessions SET status = 'complete' WHERE code = $1", [lobbyCode]);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    console.error('[lobby PATCH]', e);
    return NextResponse.json({ error: 'Failed to update lobby' }, { status: 500 });
  }
}
