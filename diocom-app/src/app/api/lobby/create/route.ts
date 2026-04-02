import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import db from '@/db';
import { randomUUID } from 'crypto';

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// POST /api/lobby/create — create a lobby
export async function POST() {
  const session = await getServerSession(authOptions);
  const id = randomUUID();
  const code = generateCode();
  const now = Date.now();
  const expires = now + 15 * 60 * 1000; // 15 min

  await db.query(`
    INSERT INTO lobby_sessions (id, code, creator_id, status, created_at, expires_at)
    VALUES ($1, $2, $3, 'waiting', $4, $5)
  `, [id, code, session?.user?.id || null, now, expires]);

  return NextResponse.json({ success: true, code, lobbyId: id, expiresAt: expires });
}
