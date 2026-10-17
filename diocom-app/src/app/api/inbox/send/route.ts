import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { InboxRepository } from '@/db/inbox';
import { AuditLogger } from '@/lib/AuditLogger';
import { enforceRateLimit } from '@/lib/rateLimit';

const HANDLE_RE = /^@?[A-Za-z0-9_.-]{1,32}$/;
const SHARE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// POST /api/inbox/send — push a file to another user by @handle
export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limited = enforceRateLimit(request, 'inbox-send', { maxRequests: 20, windowMs: 60_000 }, session.user.id);
  if (limited) return limited;

  try {
  const { handle: rawHandle, shareId, message } = await request.json().catch(() => ({}));
  if (typeof rawHandle !== 'string' || !HANDLE_RE.test(rawHandle) || typeof shareId !== 'string' || !SHARE_ID_RE.test(shareId)) {
    return NextResponse.json({ error: 'Valid handle and shareId required' }, { status: 400 });
  }
  if (message !== undefined && message !== null && (typeof message !== 'string' || message.length > 500)) {
    return NextResponse.json({ error: 'Message must be at most 500 characters' }, { status: 400 });
  }
  const handle = rawHandle.replace(/^@/, '');

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
  } catch (e) {
    console.error('[inbox/send POST]', e);
    return NextResponse.json({ error: 'Failed to send' }, { status: 500 });
  }
}

// GET /api/inbox/send — search for handles (autocomplete)
export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const limited = enforceRateLimit(request, 'inbox-search', { maxRequests: 60, windowMs: 60_000 }, session.user.id);
  if (limited) return limited;

  try {
    const { searchParams } = new URL(request.url);
    const q = (searchParams.get('q') || '').slice(0, 32);
    const results = await InboxRepository.searchHandles(q);
    return NextResponse.json({ success: true, results });
  } catch (e) {
    console.error('[inbox/send GET]', e);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}
