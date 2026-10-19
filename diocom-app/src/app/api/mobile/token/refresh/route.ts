import { NextResponse } from 'next/server';
import { rotateRefreshToken } from '@/lib/auth/mobileTokens';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, recordMobileToken, setRequestUser } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mobile/token/refresh  { refreshToken } -> a new token pair (the old refresh token is now spent).
 * Re-using a spent refresh token revokes its whole family (401 invalid_grant; the app must sign in again).
 */
async function handlePOST(req: Request) {
    const limited = await enforceRateLimit(req, 'mobile-refresh', { maxRequests: 30, windowMs: 60_000 });
    if (limited) return limited;
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_request' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    const r = await rotateRefreshToken(body.refreshToken);
    recordMobileToken('refresh', r.ok ? 'ok' : r.reason);
    if (!r.ok) {
        return NextResponse.json(
            { error: 'invalid_grant', reason: r.reason, message: 'Session expired. Please sign in again.' },
            { status: 401, headers: { 'Cache-Control': 'no-store' } },
        );
    }
    setRequestUser(r.userId);
    return NextResponse.json(r.pair, { headers: { 'Cache-Control': 'no-store' } });
}

export const POST = withObservability(handlePOST, '/api/mobile/token/refresh');
