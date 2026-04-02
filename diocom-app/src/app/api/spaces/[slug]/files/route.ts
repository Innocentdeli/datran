import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../auth/[...nextauth]/route';
import db from '@/db';

// GET /api/spaces/[slug]/files — list files in a space
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const spaceRes = await db.query('SELECT * FROM spaces WHERE slug = $1', [slug]);
  const space = spaceRes.rows[0];
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  const filesRes = await db.query(`
    SELECT f.*, sf.uploaded_at, sf.uploaded_by, u.name AS uploader_name
    FROM space_files sf
    JOIN files f ON f.share_id = sf.file_id
    JOIN users u ON u.id = sf.uploaded_by
    WHERE sf.space_id = $1
    ORDER BY sf.uploaded_at DESC
  `, [space.id]);

  return NextResponse.json({ success: true, files: filesRes.rows });
}

// POST /api/spaces/[slug]/files — add a file to a space
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { shareId } = await request.json();
  if (!shareId) return NextResponse.json({ error: 'shareId required' }, { status: 400 });

  const spaceRes = await db.query('SELECT * FROM spaces WHERE slug = $1', [slug]);
  const space = spaceRes.rows[0];
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  // Check membership
  const memberRes = await db.query('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [space.id, session.user.id]);
  const member = memberRes.rows[0];
  if (!member && !space.is_public) {
    return NextResponse.json({ error: 'Not a member of this space' }, { status: 403 });
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
export async function DELETE(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { shareId } = await request.json();
  const spaceRes = await db.query('SELECT * FROM spaces WHERE slug = $1', [slug]);
  const space = spaceRes.rows[0];
  if (!space) return NextResponse.json({ error: 'Space not found' }, { status: 404 });

  await db.query('DELETE FROM space_files WHERE space_id = $1 AND file_id = $2 AND uploaded_by = $3', [space.id, shareId, session.user.id]);
  return NextResponse.json({ success: true });
}
