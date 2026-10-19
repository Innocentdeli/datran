import { NextResponse } from 'next/server';
import { authorizeCredentials, CredentialsError } from '@/lib/auth/credentials';
import { issueTokenPair } from '@/lib/auth/mobileTokens';
import { getClientIp } from '@/lib/security';
import { AuditLogger } from '@/lib/AuditLogger';
import { withObservability, recordAuth, recordMobileToken, setRequestUser, getLogger } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * POST /api/mobile/token  { email, password } | { passkeyToken }
 * -> { accessToken, accessExpiresIn, refreshToken, refreshExpiresIn, tokenType: 'Bearer' }
 * Same credential checks and rate limits as the web sign-in (src/lib/auth/credentials.ts); never creates accounts.
 */
async function handlePOST(req: Request) {
    let body: Record<string, unknown>;
    try {
        body = await req.json();
    } catch {
        return NextResponse.json({ error: 'invalid_request', message: 'Invalid JSON' }, { status: 400, headers: NO_STORE });
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    const method = body.passkeyToken ? 'mobile_passkey' : 'mobile_password';
    try {
        const user = await authorizeCredentials(
            { email: str(body.email), password: str(body.password), passkeyToken: str(body.passkeyToken) },
            getClientIp(req),
            { allowSignUp: false },
        );
        if (!user) {
            recordAuth(method, 'failure');
            recordMobileToken('issue', 'invalid_request');
            return NextResponse.json({ error: 'invalid_request', message: 'Email and password (or a passkey token) are required' }, { status: 400, headers: NO_STORE });
        }
        setRequestUser(user.id);
        const pair = await issueTokenPair(user);
        recordAuth(method, 'success');
        recordMobileToken('issue', 'ok');
        AuditLogger.record({ userId: user.id, action: 'USER_SIGNIN', resource: 'AUTH_MOBILE', details: 'Mobile app signed in (token issued)' });
        return NextResponse.json(pair, { headers: NO_STORE });
    } catch (e) {
        if (e instanceof CredentialsError) {
            recordAuth(method, e.rateLimited ? 'rate_limited' : 'failure');
            recordMobileToken('issue', e.rateLimited ? 'rate_limited' : 'invalid_grant');
            return NextResponse.json(
                { error: e.rateLimited ? 'rate_limited' : 'invalid_grant', message: e.message },
                { status: e.rateLimited ? 429 : 401, headers: { ...NO_STORE, ...(e.rateLimited ? { 'Retry-After': '300' } : {}) } },
            );
        }
        recordMobileToken('issue', 'error');
        getLogger().error({ err: e }, 'mobile token issue failed');
        throw e;
    }
}

export const POST = withObservability(handlePOST, '/api/mobile/token');
