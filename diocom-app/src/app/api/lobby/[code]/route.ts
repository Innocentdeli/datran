import { NextResponse } from 'next/server';
import db from '@/db';
import { enforceRateLimit } from '@/lib/rateLimit';
import { getLobbyRole, lobbyRoleToken, optionalUserId, setLobbyRoleCookie } from '../_shared';
import { withObservability, getLogger } from '@/lib/observability';

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LOBBY_FILES = 50;
// Codes are short, so lookups are rate limited to prevent enumeration
const LOOKUP_LIMIT = { maxRequests: 60, windowMs: 60_000 };

function parseFileIds(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === 'string');
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Public metadata of the files dropped into a lobby (only shown to participants). */
async function lobbyFiles(fileIds: string[]) {
  const out: { shareId: string; name: string; size: number; mimeType: string | null; hasPassword: boolean }[] = [];
  for (const shareId of fileIds) {
    const res = await db.query('SELECT * FROM files WHERE share_id = $1', [shareId]);
    const f = res.rows[0];
    if (!f) continue; // expired / deleted since it was dropped
    out.push({
      shareId,
      name: String(f.original_name),
      size: Number(f.file_size) || 0,
      mimeType: (f.mime_type as string | null) ?? null,
      hasPassword: !!f.password_hash,
    });
  }
  return out;
}

// GET /api/lobby/[code] — poll lobby state (participants also get the dropped files)
async function handleGET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const limited = await enforceRateLimit(req, 'lobby-get', LOOKUP_LIMIT);
  if (limited) return limited;

  try {
    const { code } = await params;
    if (!CODE_RE.test(code)) return NextResponse.json({ error: 'Lobby not found' }, { status: 404 });
    const res = await db.query('SELECT * FROM lobby_sessions WHERE code = $1', [code]);
    const lobby = res.rows[0];
    if (!lobby) return NextResponse.json({ error: 'Lobby not found' }, { status: 404 });
    if (Number(lobby.expires_at) < Date.now()) return NextResponse.json({ status: 'expired' });

    const role = await getLobbyRole(String(lobby.id), req);
    // User ids are never exposed; file ids only to verified participants
    return NextResponse.json({
      status: lobby.status,
      code: lobby.code,
      expiresAt: lobby.expires_at,
      role,
      files: role ? await lobbyFiles(parseFileIds(lobby.file_ids)) : [],
    });
  } catch (e) {
    getLogger().error({ err: e }, 'lobby GET');
    return NextResponse.json({ error: 'Failed to load lobby' }, { status: 500 });
  }
}

// PATCH /api/lobby/[code] — join, drop files into, or complete a lobby
async function handlePATCH(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const limited = await enforceRateLimit(request, 'lobby-patch', { maxRequests: 30, windowMs: 60_000 });
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
    const lobbyId = String(lobby.id);

    if (action === 'join') {
      if (lobby.status !== 'waiting') {
        return NextResponse.json({ error: 'Lobby is no longer waiting' }, { status: 400 });
      }
      const joinerId = await optionalUserId(request);
      await db.query('UPDATE lobby_sessions SET joiner_id = $1, status = $2 WHERE code = $3',
        [joinerId, 'active', lobbyCode]);

      const out = NextResponse.json({ success: true, status: 'active', token: lobbyRoleToken(lobbyId, 'joiner') });
      setLobbyRoleCookie(out, lobbyId, 'joiner');
      return out;
    }

    if (action === 'add_files') {
      // Only the host drops files; the receiver picks them up via GET.
      const role = await getLobbyRole(lobbyId, request);
      if (role !== 'creator') return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      if (lobby.status !== 'active') {
        return NextResponse.json({ error: 'Lobby is not active' }, { status: 400 });
      }
      const shareIds = (body as { shareIds?: unknown }).shareIds;
      if (!Array.isArray(shareIds) || shareIds.length === 0 || !shareIds.every((s) => typeof s === 'string' && SHARE_ID_RE.test(s))) {
        return NextResponse.json({ error: 'shareIds must be a non-empty array of share ids' }, { status: 400 });
      }
      const merged = Array.from(new Set([...parseFileIds(lobby.file_ids), ...(shareIds as string[])]));
      if (merged.length > MAX_LOBBY_FILES) {
        return NextResponse.json({ error: `A lobby holds at most ${MAX_LOBBY_FILES} files` }, { status: 400 });
      }
      await db.query('UPDATE lobby_sessions SET file_ids = $1 WHERE code = $2', [JSON.stringify(merged), lobbyCode]);
      return NextResponse.json({ success: true, files: await lobbyFiles(merged) });
    }

    if (action === 'complete') {
      // Only lobby participants (creator or joiner) may complete it
      const role = await getLobbyRole(lobbyId, request);
      if (!role) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      if (lobby.status !== 'active') {
        return NextResponse.json({ error: 'Lobby is not active' }, { status: 400 });
      }
      await db.query("UPDATE lobby_sessions SET status = 'complete' WHERE code = $1", [lobbyCode]);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  } catch (e) {
    getLogger().error({ err: e }, 'lobby PATCH');
    return NextResponse.json({ error: 'Failed to update lobby' }, { status: 500 });
  }
}

export const GET = withObservability(handleGET, '/api/lobby/[code]');
export const PATCH = withObservability(handlePATCH, '/api/lobby/[code]');
