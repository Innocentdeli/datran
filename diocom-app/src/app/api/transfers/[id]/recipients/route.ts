import { NextResponse } from 'next/server';
import { requireRequestUser } from '@/lib/auth/requestUser';
import { DeliveryService } from '@/lib/transfers/deliveryService';
import db from '@/db';
import { withObservability } from '@/lib/observability';

async function handleGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireRequestUser(request);
  if (user instanceof NextResponse) return user;

  const fileRes = await db.query('SELECT user_id FROM files WHERE share_id = $1', [id]);
  const file = fileRes.rows[0];
  if (!file || file.user_id !== user.id) {
    return NextResponse.json({ error: 'File not found or access denied' }, { status: 404 });
  }

  const recipients = await DeliveryService.listRecipients(id);
  return NextResponse.json({ success: true, recipients });
}

export const GET = withObservability(handleGET, '/api/transfers/[id]/recipients');
