import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { InboxRepository } from '@/db/inbox';
import { withObservability, getLogger } from '@/lib/observability';

// PATCH /api/inbox/[id] — accept or decline an inbox item
async function handlePATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { action } = await request.json().catch(() => ({}));
  if (!action || !['accept', 'decline'].includes(action)) {
    return NextResponse.json({ error: 'action must be "accept" or "decline"' }, { status: 400 });
  }

  let result;
  try {
    result = await InboxRepository.updateStatus(id, session.user.id, action === 'accept' ? 'accepted' : 'declined');
  } catch (e) {
    getLogger().error({ err: e }, 'inbox PATCH');
    return NextResponse.json({ error: 'Failed to update item' }, { status: 500 });
  }
  if (result.rowCount === 0) {
    return NextResponse.json({ error: 'Item not found or unauthorized' }, { status: 404 });
  }

  return NextResponse.json({ success: true, status: action === 'accept' ? 'accepted' : 'declined' });
}

export const PATCH = withObservability(handlePATCH, '/api/inbox/[id]');
