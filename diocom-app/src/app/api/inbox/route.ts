import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]/route';
import { InboxRepository } from '@/db/inbox';

// GET /api/inbox — fetch all inbox items for current user
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const items = await InboxRepository.findByRecipient(session.user.id);
  const pendingCount = await InboxRepository.countPending(session.user.id);
  return NextResponse.json({ success: true, items, pendingCount });
}
