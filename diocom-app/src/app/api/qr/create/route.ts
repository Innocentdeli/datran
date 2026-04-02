import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import db from '@/db';
import { randomUUID } from 'crypto';

// POST /api/qr/create — create a QR pairing session
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  const { fileIds } = await request.json().catch(() => ({ fileIds: [] }));

  const id = randomUUID();
  const now = Date.now();
  const expires = now + 5 * 60 * 1000; // 5 min TTL

  await db.query(`
    INSERT INTO qr_sessions (id, creator_id, status, file_ids, created_at, expires_at)
    VALUES ($1, $2, 'waiting', $3, $4, $5)
  `, [id, session?.user?.id || null, JSON.stringify(fileIds || []), now, expires]);

  return NextResponse.json({
    success: true,
    sessionId: id,
    pairUrl: `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/pair/${id}`,
    expiresAt: expires
  });
}
