import { NextResponse } from 'next/server';
import { getRequestUser, requireRequestUser } from '@/lib/auth/requestUser';
import db from '@/db';
import { toPublicFile } from '@/db/files';
import { withObservability } from '@/lib/observability';

// GET /api/spaces/[slug] — get space details + members + files
async function handleGET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  let callerUser = null;
  try {
    callerUser = await getRequestUser(req);
  } catch {}
  
  const spaceRes = await db.query('SELECT * FROM spaces WHERE slug = $1', [slug]);
  const space = spaceRes.rows[0];
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  let isMember = null;
  if (callerUser?.id) {
    const memberRes = await db.query(
      'SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
      [space.id, callerUser.id]
    );
    isMember = memberRes.rows[0];
  }

  if (!space.is_public && !isMember) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const membersRes = await db.query(`
    SELECT u.id, u.name, u.image, u.username, sm.role
    FROM space_members sm JOIN users u ON u.id = sm.user_id
    WHERE sm.space_id = $1
  `, [space.id]);

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

  return NextResponse.json({ success: true, space, members: membersRes.rows, files });
}

// DELETE /api/spaces/[slug] — delete space (owner only)
async function handleDELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireRequestUser(req);
  if (user instanceof NextResponse) return user;

  const spaceRes = await db.query('SELECT * FROM spaces WHERE slug = $1 AND owner_id = $2', [slug, user.id]);
  const space = spaceRes.rows[0];
  if (!space) return NextResponse.json({ error: 'Not found or unauthorized' }, { status: 404 });

  await db.query('DELETE FROM space_files WHERE space_id = $1', [space.id]);
  await db.query('DELETE FROM space_members WHERE space_id = $1', [space.id]);
  await db.query('DELETE FROM spaces WHERE id = $1', [space.id]);

  return NextResponse.json({ success: true });
}

export const GET = withObservability(handleGET, '/api/spaces/[slug]');
export const DELETE = withObservability(handleDELETE, '/api/spaces/[slug]');
