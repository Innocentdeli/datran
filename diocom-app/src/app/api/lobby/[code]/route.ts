import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import db from '@/db';

// GET /api/lobby/[code] — poll lobby state
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const res = await db.query('SELECT * FROM lobby_sessions WHERE code = $1', [code]);
  const lobby = res.rows[0];
  if (!lobby) return NextResponse.json({ error: 'Lobby not found' }, { status: 404 });
  if (lobby.expires_at < Date.now()) return NextResponse.json({ status: 'expired' });

  return NextResponse.json({
    status: lobby.status,
    code: lobby.code,
    creatorId: lobby.creator_id,
    joinerId: lobby.joiner_id,
    expiresAt: lobby.expires_at
  });
}

// PATCH /api/lobby/[code] — join or update lobby
export async function PATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code: lobbyCode } = await params;
  const session = await getServerSession(authOptions);
  const { action } = await request.json();
  const res = await db.query('SELECT * FROM lobby_sessions WHERE code = $1', [lobbyCode]);
  const lobby = res.rows[0];
  if (!lobby) return NextResponse.json({ error: 'Lobby not found' }, { status: 404 });

  if (action === 'join') {
    if (lobby.status !== 'waiting') {
      return NextResponse.json({ error: 'Lobby is no longer waiting' }, { status: 400 });
    }
    await db.query('UPDATE lobby_sessions SET joiner_id = $1, status = $2 WHERE code = $3', 
      [session?.user?.id || null, 'active', lobbyCode]);

    return NextResponse.json({ success: true, status: 'active' });
  }

  if (action === 'complete') {
    await db.query("UPDATE lobby_sessions SET status = 'complete' WHERE code = $1", [lobbyCode]);
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
}
