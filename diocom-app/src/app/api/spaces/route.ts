import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]/route';
import db from '@/db';
import { randomUUID } from 'crypto';
import { withObservability } from '@/lib/observability';

function slugify(name: string) {
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40)
    + '-' + Math.random().toString(36).slice(2, 7);
}

// GET /api/spaces — list user spaces
async function handleGET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const ownedRes = await db.query(`SELECT * FROM spaces WHERE owner_id = $1 ORDER BY created_at DESC`, [session.user.id]);
  const memberRes = await db.query(`
    SELECT s.* FROM spaces s
    JOIN space_members sm ON sm.space_id = s.id
    WHERE sm.user_id = $1 AND s.owner_id != $2
    ORDER BY s.created_at DESC
  `, [session.user.id, session.user.id]);

  return NextResponse.json({ success: true, owned: ownedRes.rows, member: memberRes.rows });
}

// POST /api/spaces — create a space
async function handlePOST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { name, description, isPublic } = await request.json();
  if (!name?.trim()) return NextResponse.json({ error: 'Name required' }, { status: 400 });

  const id = randomUUID();
  const slug = slugify(name);
  const now = Date.now();

  await db.query(`
    INSERT INTO spaces (id, owner_id, name, slug, description, is_public, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [id, session.user.id, name.trim(), slug, description || null, isPublic ? 1 : 0, now]);

  // Auto-add creator as owner member
  await db.query(`INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`, [id, session.user.id, now]);

  return NextResponse.json({ success: true, id, slug });
}

export const GET = withObservability(handleGET, '/api/spaces');
export const POST = withObservability(handlePOST, '/api/spaces');
