import { NextResponse } from 'next/server';
import { requireRequestUser } from '@/lib/auth/requestUser';
import { FileRequestService } from '@/lib/requests/service';
import { withObservability } from '@/lib/observability';

async function handleGET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireRequestUser(request);
  if (user instanceof NextResponse) return user;

  const data = await FileRequestService.getRequestDetails(id, user.id);
  if (!data) {
    return NextResponse.json({ error: 'File request not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, ...data });
}

async function handlePATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireRequestUser(request);
  if (user instanceof NextResponse) return user;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (typeof body.isActive === 'boolean') {
    const updated = await FileRequestService.toggleActive(id, user.id, body.isActive);
    if (!updated) return NextResponse.json({ error: 'Request not found' }, { status: 404 });
    return NextResponse.json({ success: true, isActive: body.isActive });
  }

  return NextResponse.json({ error: 'No valid update fields provided' }, { status: 400 });
}

async function handleDELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireRequestUser(request);
  if (user instanceof NextResponse) return user;

  const deleted = await FileRequestService.deleteRequest(id, user.id);
  if (!deleted) {
    return NextResponse.json({ error: 'File request not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}

export const GET = withObservability(handleGET, '/api/requests/[id]');
export const PATCH = withObservability(handlePATCH, '/api/requests/[id]');
export const DELETE = withObservability(handleDELETE, '/api/requests/[id]');
