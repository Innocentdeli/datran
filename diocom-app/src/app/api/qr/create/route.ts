import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import db from '@/db';
import { randomUUID } from 'crypto';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, getLogger } from '@/lib/observability';

const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FILES = 20;

// POST /api/qr/create — create a QR pairing session.
// The (random UUID) session id is the pairing secret embedded in the QR code.
async function handlePOST(request: Request) {
  const limited = await enforceRateLimit(request, 'qr-create', { maxRequests: 20, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const session = await getServerSession(authOptions);
    const body = await request.json().catch(() => ({}));
    const rawIds = (body as { fileIds?: unknown }).fileIds;
    const fileIds = Array.isArray(rawIds)
      ? rawIds.filter((x): x is string => typeof x === 'string' && SHARE_ID_RE.test(x)).slice(0, MAX_FILES)
      : [];

    const id = randomUUID();
    const now = Date.now();
    const expires = now + 5 * 60 * 1000; // 5 min TTL

    await db.query(`
      INSERT INTO qr_sessions (id, creator_id, status, file_ids, created_at, expires_at)
      VALUES ($1, $2, 'waiting', $3, $4, $5)
    `, [id, (session?.user as { id?: string } | undefined)?.id || null, JSON.stringify(fileIds), now, expires]);

    return NextResponse.json({
      success: true,
      sessionId: id,
      pairUrl: `${process.env.NEXTAUTH_URL || 'http://localhost:3000'}/pair/${id}`,
      expiresAt: expires
    });
  } catch (e) {
    getLogger().error({ err: e }, 'qr/create');
    return NextResponse.json({ error: 'Failed to create session' }, { status: 500 });
  }
}

export const POST = withObservability(handlePOST, '/api/qr/create');
