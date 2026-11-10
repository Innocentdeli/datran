import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, getLogger } from '@/lib/observability';
import { submitAbuseReport, type AbuseReason } from '@/lib/security/abuse';
import { FileRepository } from '@/db/files';

const VALID_REASONS: AbuseReason[] = ['malware', 'dmca', 'illegal', 'harassment', 'spam', 'other'];

async function handlePOST(request: Request) {
  const limited = await enforceRateLimit(request, 'abuse-report', { maxRequests: 5, windowMs: 60_000 });
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const { shareId, reason, details, reporterEmail } = body as {
      shareId?: string;
      reason?: AbuseReason;
      details?: string;
      reporterEmail?: string;
    };

    if (!shareId || typeof shareId !== 'string') {
      return NextResponse.json({ error: 'Valid file link or shareId is required' }, { status: 400 });
    }

    if (!reason || !VALID_REASONS.includes(reason)) {
      return NextResponse.json({ error: 'Valid abuse reason is required' }, { status: 400 });
    }

    // Check that file actually exists
    const file = await FileRepository.findByShareId(shareId);
    if (!file) {
      return NextResponse.json({ error: 'Reported file not found' }, { status: 404 });
    }

    const clientIp = request.headers.get('x-forwarded-for')?.split(',')[0].trim() || '127.0.0.1';

    const report = await submitAbuseReport({
      shareId,
      reason,
      details,
      reporterEmail,
      ipAddress: clientIp,
    });

    return NextResponse.json({
      success: true,
      reportId: report.id,
      message: 'Report submitted successfully. Our trust & safety team has received the notice.',
    });
  } catch (err) {
    getLogger().error({ err }, 'abuse/report POST');
    return NextResponse.json({ error: 'Failed to submit abuse report' }, { status: 500 });
  }
}

export const POST = withObservability(handlePOST, '/api/abuse/report');
