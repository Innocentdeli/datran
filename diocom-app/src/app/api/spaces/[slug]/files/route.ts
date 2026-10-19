import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../auth/[...nextauth]/route';
import db from '@/db';
import { toPublicFile } from '@/db/files';
import { withObservability } from '@/lib/observability';

// GET /api/spaces/[slug]/files — list files in a space (private spaces: members only)
async function handleGET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const spaceRes = await db.query('SELECT * FROM spaces WHERE slug = $1', [slug]);
  const space = spaceRes.rows[0];
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  if (!space.is_public) {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    const memberRes = await db.query(
      'SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
      [space.id, session.user.id]
    );
    if (!memberRes.rows[0]) return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const filesRes = await db.query(`
    SELECT f.*, sf.uploaded_at, sf.uploaded_by, u.name AS uploader_name
    FROM space_files sf
    JOIN files f ON f.share_id = sf.file_id
    JOIN users u ON u.id = sf.uploaded_by
    WHERE sf.space_id = $1
    ORDER BY sf.uploaded_at DESC
  `, [space.id]);

  const files = filesRes.rows.map(f => ({
    ...toPublicFile(f),
    uploaded_at: f.uploaded_at,
    uploaded_by: f.uploaded_by,
    uploader_name: f.uploader_name,
  }));

  return NextResponse.json({ success: true, files });
}

// POST /api/spaces/[slug]/files — add one of the caller's own files to a space
async function handlePOST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { shareId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  const shareId = body?.shareId;
  if (typeof shareId !== 'string' || !shareId) return NextResponse.json({ error: 'shareId required' }, { status: 400 });

  const spaceRes = await db.query('SELECT * FROM spaces WHERE slug = $1', [slug]);
  const space = spaceRes.rows[0];
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  // Check membership
  const memberRes = await db.query('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [space.id, session.user.id]);
  const member = memberRes.rows[0];
  if (!member && !space.is_public) {
    return NextResponse.json({ error: 'Not a member of this space' }, { status: 403 });
  }

  // Only the file's owner may attach it to a space.
  const fileRes = await db.query('SELECT user_id FROM files WHERE share_id = $1', [shareId]);
  const file = fileRes.rows[0];
  if (!file || file.user_id !== session.user.id) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const now = Date.now();
  await db.query(`
    INSERT INTO space_files (space_id, file_id, uploaded_by, uploaded_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (space_id, file_id) DO UPDATE SET uploaded_at = EXCLUDED.uploaded_at, uploaded_by = EXCLUDED.uploaded_by
  `, [space.id, shareId, session.user.id, now]);

  return NextResponse.json({ success: true });
}

// DELETE /api/spaces/[slug]/files — remove a file
async function handleDELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: { shareId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Bad request' }, { status: 400 });
  }
  const shareId = body?.shareId;
  if (typeof shareId !== 'string' || !shareId) return NextResponse.json({ error: 'shareId required' }, { status: 400 });

  const spaceRes = await db.query('SELECT * FROM spaces WHERE slug = $1', [slug]);
  const space = spaceRes.rows[0];
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  await db.query('DELETE FROM space_files WHERE space_id = $1 AND file_id = $2 AND uploaded_by = $3', [space.id, shareId, session.user.id]);
  return NextResponse.json({ success: true });
}

export const GET = withObservability(handleGET, '/api/spaces/[slug]/files');
export const POST = withObservability(handlePOST, '/api/spaces/[slug]/files');
export const DELETE = withObservability(handleDELETE, '/api/spaces/[slug]/files');
