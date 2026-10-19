import { NextResponse } from 'next/server';
import { revokeRefreshToken } from '@/lib/auth/mobileTokens';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, recordMobileToken } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/mobile/token/revoke { refreshToken }: sign-out (revokes the token family). Always 200 (RFC 7009). */
async function handlePOST(req: Request) {
    const limited = await enforceRateLimit(req, 'mobile-revoke', { maxRequests: 30, windowMs: 60_000 });
    if (limited) return limited;
    let token: unknown = null;
    try {
        token = ((await req.json()) as Record<string, unknown>).refreshToken;
    } catch {
        /* treated as unknown token */
    }
    const revoked = await revokeRefreshToken(token);
    recordMobileToken('revoke', revoked ? 'ok' : 'unknown');
    return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
}

export const POST = withObservability(handlePOST, '/api/mobile/token/revoke');
