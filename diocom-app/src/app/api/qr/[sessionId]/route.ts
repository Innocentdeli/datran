import { NextResponse } from 'next/server';
import db from '@/db';

// GET /api/qr/[sessionId] — poll QR session state
// GET /api/qr/[sessionId] — poll QR session state
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const res = await db.query('SELECT * FROM qr_sessions WHERE id = $1', [sessionId]);
  const row = res.rows[0];
  if (!row) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  if (row.expires_at < Date.now()) {
    return NextResponse.json({ status: 'expired' });
  }

  return NextResponse.json({
    status: row.status,
    fileIds: typeof row.file_ids === 'string' ? JSON.parse(row.file_ids) : row.file_ids,
    expiresAt: row.expires_at
  });
}

// PATCH /api/qr/[sessionId] — update session state (paired -> complete)
export async function PATCH(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const { status } = await request.json();
  const allowed = ['paired', 'complete'];
  if (!allowed.includes(status)) {
    return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
  }
  await db.query('UPDATE qr_sessions SET status = $1 WHERE id = $2', [status, sessionId]);
  return NextResponse.json({ success: true });
}
