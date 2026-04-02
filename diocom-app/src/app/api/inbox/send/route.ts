import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { InboxRepository } from '@/db/inbox';
import { AuditLogger } from '@/lib/AuditLogger';

// POST /api/inbox/send — push a file to another user by @handle
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { handle, shareId, message } = await request.json();
  if (!handle || !shareId) {
    return NextResponse.json({ error: 'handle and shareId required' }, { status: 400 });
  }

  // Resolve @handle to user
  const recipient = await InboxRepository.resolveHandle(handle);
  if (!recipient) {
    return NextResponse.json({ error: `User @${handle} not found` }, { status: 404 });
  }

  if (recipient.id === session.user.id) {
    return NextResponse.json({ error: 'You cannot send to yourself' }, { status: 400 });
  }

  const item = await InboxRepository.send(session.user.id, recipient.id, shareId, message);

  await AuditLogger.record({
    userId: session.user.id,
    action: 'INBOX_PUSH',
    resource: shareId,
    details: `Pushed file to @${handle} (${recipient.id})`
  });

  return NextResponse.json({ success: true, item, recipient: { name: recipient.name, username: recipient.username } });
}

// GET /api/inbox/send — search for handles (autocomplete)
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const q = searchParams.get('q') || '';
  const results = await InboxRepository.searchHandles(q);
  return NextResponse.json({ success: true, results });
}
