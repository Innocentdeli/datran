import { NextRequest, NextResponse } from 'next/server';
import { ReviewService } from '@/lib/reviews/service';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'File ID is required' }, { status: 400 });

  try {
    const body = await req.json();
    const { authorName, authorEmail, comment, timestampSeconds, coordX, coordY } = body;

    if (!authorName || !comment) {
      return NextResponse.json({ error: 'Author name and comment are required' }, { status: 400 });
    }

    const newComment = await ReviewService.addComment({
      fileId: id,
      authorName,
      authorEmail,
      comment,
      timestampSeconds: timestampSeconds != null ? Number(timestampSeconds) : undefined,
      coordX: coordX != null ? Number(coordX) : undefined,
      coordY: coordY != null ? Number(coordY) : undefined,
    });

    return NextResponse.json({ success: true, comment: newComment });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to post comment' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { commentId, resolved } = body;

    if (!commentId || resolved === undefined) {
      return NextResponse.json({ error: 'commentId and resolved are required' }, { status: 400 });
    }

    await ReviewService.toggleCommentResolved(commentId, !!resolved);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to update comment' }, { status: 500 });
  }
}
