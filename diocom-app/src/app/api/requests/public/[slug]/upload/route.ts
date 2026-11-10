import { NextResponse } from 'next/server';
import { FileRequestService } from '@/lib/requests/service';
import { withObservability } from '@/lib/observability';

async function handlePOST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!slug) return NextResponse.json({ error: 'Slug is required' }, { status: 400 });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const { fileId, fileSize, uploaderName, uploaderEmail, uploaderNote } = body;
  if (!fileId || typeof fileId !== 'string') {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
  }

  try {
    const outcome = await FileRequestService.attachUpload(slug, {
      fileId,
      fileSize: Number(fileSize) || 0,
      uploaderName,
      uploaderEmail,
      uploaderNote
    });

    return NextResponse.json(outcome);
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to link upload' }, { status: 400 });
  }
}

export const POST = withObservability(handlePOST, '/api/requests/public/[slug]/upload');
