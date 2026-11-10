import { NextResponse } from 'next/server';
import { requireRequestUser } from '@/lib/auth/requestUser';
import { FileRequestService } from '@/lib/requests/service';
import { withObservability } from '@/lib/observability';

async function handleGET(request: Request) {
  const user = await requireRequestUser(request);
  if (user instanceof NextResponse) return user;

  const requests = await FileRequestService.listUserRequests(user.id);
  return NextResponse.json({ success: true, requests });
}

async function handlePOST(request: Request) {
  const user = await requireRequestUser(request);
  if (user instanceof NextResponse) return user;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  if (!body.title || typeof body.title !== 'string') {
    return NextResponse.json({ error: 'Title is required' }, { status: 400 });
  }

  try {
    const fileRequest = await FileRequestService.createRequest(user.id, {
      title: body.title,
      description: body.description,
      slug: body.slug,
      destinationSpaceId: body.destinationSpaceId,
      maxFileSize: body.maxFileSize ? Number(body.maxFileSize) : undefined,
      expiresInHours: body.expiresInHours ? Number(body.expiresInHours) : undefined,
      recipientPublicKey: body.recipientPublicKey,
    });

    return NextResponse.json({ success: true, request: fileRequest }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to create file request' }, { status: 500 });
  }
}

export const GET = withObservability(handleGET, '/api/requests');
export const POST = withObservability(handlePOST, '/api/requests');
