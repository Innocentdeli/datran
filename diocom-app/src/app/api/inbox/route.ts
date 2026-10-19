import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]/route';
import { InboxRepository } from '@/db/inbox';
import { withObservability, getLogger } from '@/lib/observability';

// GET /api/inbox — fetch all inbox items for current user
async function handleGET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const items = await InboxRepository.findByRecipient(session.user.id);
    const pendingCount = await InboxRepository.countPending(session.user.id);
    return NextResponse.json({ success: true, items, pendingCount });
  } catch (e) {
    getLogger().error({ err: e }, 'inbox GET');
    return NextResponse.json({ error: 'Failed to load inbox' }, { status: 500 });
  }
}

export const GET = withObservability(handleGET, '/api/inbox');
