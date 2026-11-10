import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { withObservability, getLogger } from '@/lib/observability';
import { getAbuseReports, resolveAbuseReport, type AbuseStatus } from '@/lib/security/abuse';

const NO_STORE = { 'Cache-Control': 'no-store' };

async function handleGET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if ((session.user as { role?: string }).role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get('status') as AbuseStatus | null;
  const limit = parseInt(searchParams.get('limit') || '50', 10);

  try {
    const reports = await getAbuseReports({
      status: statusParam || undefined,
      limit,
    });
    return NextResponse.json({ success: true, reports }, { headers: NO_STORE });
  } catch (err) {
    getLogger().error({ err }, 'admin/moderation GET');
    return NextResponse.json({ error: 'Failed to fetch moderation reports' }, { status: 500 });
  }
}

async function handlePOST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if ((session.user as { role?: string }).role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  try {
    const body = await request.json().catch(() => ({}));
    const { reportId, action, reason } = body as {
      reportId?: string;
      action?: 'disable_file' | 'dismiss' | 'ban_user';
      reason?: string;
    };

    if (!reportId || !action || !['disable_file', 'dismiss', 'ban_user'].includes(action)) {
      return NextResponse.json({ error: 'Valid reportId and action required' }, { status: 400 });
    }

    const adminId = (session.user as { id?: string }).id;
    const result = await resolveAbuseReport({
      reportId,
      action,
      adminId,
      reason,
    });

    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    getLogger().error({ err }, 'admin/moderation POST');
    return NextResponse.json({ error: 'Failed to resolve moderation report' }, { status: 500 });
  }
}

export const GET = withObservability(handleGET, '/api/admin/moderation');
export const POST = withObservability(handlePOST, '/api/admin/moderation');
