import { NextResponse } from 'next/server';
import { FileRequestService } from '@/lib/requests/service';
import { withObservability } from '@/lib/observability';

export const dynamic = 'force-dynamic';

async function handleGET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!slug) return NextResponse.json({ error: 'Slug is required' }, { status: 400 });

  const reqData = await FileRequestService.getPublicRequest(slug);
  if (!reqData) {
    return NextResponse.json({ error: 'File request not found' }, { status: 404 });
  }

  return NextResponse.json({ success: true, request: reqData });
}

export const GET = withObservability(handleGET, '/api/requests/public/[slug]');
