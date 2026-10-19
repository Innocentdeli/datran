import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import db from '@/db';
import { randomUUID, randomInt } from 'crypto';
import { enforceRateLimit } from '@/lib/rateLimit';
import { setLobbyRoleCookie } from '../_shared';
import { withObservability, getLogger } from '@/lib/observability';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateCode() {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_CHARS[randomInt(CODE_CHARS.length)];
  return out;
}

// POST /api/lobby/create — create a lobby
async function handlePOST(request: Request) {
  const limited = await enforceRateLimit(request, 'lobby-create', { maxRequests: 10, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const session = await getServerSession(authOptions);
    const creatorId = (session?.user as { id?: string } | undefined)?.id || null;
    const id = randomUUID();
    const now = Date.now();
    const expires = now + 15 * 60 * 1000; // 15 min

    let code = '';
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = generateCode();
      const existing = await db.query('SELECT * FROM lobby_sessions WHERE code = $1', [candidate]);
      if (existing.rows.length === 0) { code = candidate; break; }
    }
    if (!code) return NextResponse.json({ error: 'Could not allocate lobby code' }, { status: 503 });

    await db.query(`
      INSERT INTO lobby_sessions (id, code, creator_id, status, created_at, expires_at)
      VALUES ($1, $2, $3, 'waiting', $4, $5)
    `, [id, code, creatorId, now, expires]);

    const res = NextResponse.json({ success: true, code, expiresAt: expires });
    // Participant secret (httpOnly cookie) — required for privileged PATCH actions
    setLobbyRoleCookie(res, id, 'creator');
    return res;
  } catch (e) {
    getLogger().error({ err: e }, 'lobby/create');
    return NextResponse.json({ error: 'Failed to create lobby' }, { status: 500 });
  }
}

export const POST = withObservability(handlePOST, '/api/lobby/create');
