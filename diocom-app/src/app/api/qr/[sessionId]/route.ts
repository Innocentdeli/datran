import { NextResponse } from 'next/server';
import db from '@/db';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, getLogger } from '@/lib/observability';

/**
 * QR pairing sessions.
 *
 * The session id is a random UUID that is only ever shown inside the QR code /
 * pair URL, so possession of it IS the pairing secret: the scanning device needs
 * the file ids (that is the purpose of pairing), and the creator polls status.
 * We therefore (a) only accept well-formed UUIDs, (b) rate limit lookups,
 * (c) stop exposing file ids once the session is complete/expired, and
 * (d) only allow forward state transitions (waiting -> paired -> complete).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIMIT = { maxRequests: 60, windowMs: 60_000 };

const TRANSITIONS: Record<string, string[]> = {
  waiting: ['paired'],
  paired: ['paired', 'complete'],
  complete: [],
};

async function loadSession(sessionId: string) {
  if (!UUID_RE.test(sessionId)) return null;
  const res = await db.query('SELECT * FROM qr_sessions WHERE id = $1', [sessionId]);
  return res.rows[0] || null;
}

// GET /api/qr/[sessionId] — poll QR session state
async function handleGET(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const limited = await enforceRateLimit(req, 'qr-get', LIMIT);
  if (limited) return limited;

  try {
    const { sessionId } = await params;
    const row = await loadSession(sessionId);
    if (!row) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

    if (Number(row.expires_at) < Date.now()) {
      return NextResponse.json({ status: 'expired' });
    }

    let fileIds: string[] = [];
    if (row.status !== 'complete') {
      try {
        fileIds = typeof row.file_ids === 'string' ? JSON.parse(row.file_ids) : (row.file_ids || []);
      } catch {
        fileIds = [];
      }
    }

    return NextResponse.json({ status: row.status, fileIds, expiresAt: row.expires_at });
  } catch (e) {
    getLogger().error({ err: e }, 'qr GET');
    return NextResponse.json({ error: 'Failed to load session' }, { status: 500 });
  }
}

// PATCH /api/qr/[sessionId] — update session state and/or append fileIds
async function handlePATCH(request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const limited = await enforceRateLimit(request, 'qr-patch', LIMIT);
  if (limited) return limited;

  try {
    const { sessionId } = await params;
    const body = await request.json().catch(() => ({}));
    const status = (body as { status?: unknown }).status;
    const incomingFileIds = (body as { fileIds?: unknown }).fileIds;

    const row = await loadSession(sessionId);
    if (!row) return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    if (Number(row.expires_at) < Date.now()) {
      return NextResponse.json({ error: 'Session expired' }, { status: 410 });
    }

    let nextStatus = row.status;
    if (status) {
      if (typeof status !== 'string' || !['paired', 'complete'].includes(status)) {
        return NextResponse.json({ error: 'Invalid status' }, { status: 400 });
      }
      if (!(TRANSITIONS[row.status] || []).includes(status)) {
        return NextResponse.json({ error: 'Invalid transition' }, { status: 409 });
      }
      nextStatus = status;
    }

    let fileIds: string[] = [];
    try {
      fileIds = typeof row.file_ids === 'string' ? JSON.parse(row.file_ids) : (row.file_ids || []);
    } catch {
      fileIds = [];
    }

    let fileIdsChanged = false;
    if (Array.isArray(incomingFileIds)) {
      const validIncoming = incomingFileIds.filter((x): x is string => typeof x === 'string' && x.length > 0);
      const combined = Array.from(new Set([...fileIds, ...validIncoming])).slice(0, 50);
      fileIds = combined;
      fileIdsChanged = true;
    }

    const fileIdsJson = JSON.stringify(fileIds);

    if (status && fileIdsChanged) {
      await db.query('UPDATE qr_sessions SET status = $1, file_ids = $2 WHERE id = $3', [nextStatus, fileIdsJson, sessionId]);
    } else if (status) {
      await db.query('UPDATE qr_sessions SET status = $1 WHERE id = $2', [nextStatus, sessionId]);
    } else if (fileIdsChanged) {
      await db.query('UPDATE qr_sessions SET file_ids = $1 WHERE id = $2', [fileIdsJson, sessionId]);
    }

    return NextResponse.json({ success: true, status: nextStatus, fileIds });
  } catch (e) {
    getLogger().error({ err: e }, 'qr PATCH');
    return NextResponse.json({ error: 'Failed to update session' }, { status: 500 });
  }
}

export const GET = withObservability(handleGET, '/api/qr/[sessionId]');
export const PATCH = withObservability(handlePATCH, '/api/qr/[sessionId]');
