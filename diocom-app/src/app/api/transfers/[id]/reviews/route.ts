import { NextRequest, NextResponse } from 'next/server';
import { ReviewService } from '@/lib/reviews/service';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'File ID is required' }, { status: 400 });

  try {
    const data = await ReviewService.getReviewsAndComments(id);
    return NextResponse.json({ success: true, ...data });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to fetch reviews' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: 'File ID is required' }, { status: 400 });

  try {
    const body = await req.json();
    const { reviewerName, reviewerEmail, status, decisionNote } = body;

    if (!reviewerName || !status) {
      return NextResponse.json({ error: 'Reviewer name and status are required' }, { status: 400 });
    }

    if (status !== 'approved' && status !== 'changes_requested') {
      return NextResponse.json({ error: 'Status must be approved or changes_requested' }, { status: 400 });
    }

    const review = await ReviewService.submitReview({
      fileId: id,
      reviewerName,
      reviewerEmail,
      status,
      decisionNote,
    });

    return NextResponse.json({ success: true, review });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to submit review' }, { status: 500 });
  }
}
