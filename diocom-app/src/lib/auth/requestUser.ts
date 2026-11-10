import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { setRequestUser } from '@/lib/observability';
import { verifyAccessToken } from './mobileTokens';
import { ApiKeyService } from './apiKeyService';

/**
 * The authenticated user of a request, from EITHER
 *  - `Authorization: Bearer dtr_live_...` (Developer CLI & CI/CD API key), or
 *  - `Authorization: Bearer <access token>` (mobile app; JWT from POST /api/mobile/token), or
 *  - the NextAuth session cookie (web).
 * A bearer header that is present but invalid/expired is an error (AuthTokenError -> 401), never a silent fallback
 * to anonymous: the app must refresh its token instead of uploading anonymously by accident.
 */

export interface RequestUser {
    id: string;
    role: string;
    via: 'bearer' | 'session';
}

export function isRequestUser(val: unknown): val is RequestUser {
    return typeof val === 'object' && val !== null && 'id' in val && 'via' in val;
}

export class AuthTokenError extends Error {
    constructor(message = 'Invalid or expired access token') {
        super(message);
        this.name = 'AuthTokenError';
    }
}

export function bearerToken(req: Request): string | null {
    const h = req.headers.get('authorization');
    if (!h) return null;
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    return m ? m[1].trim() : null;
}

export async function getRequestUser(req: Request): Promise<RequestUser | null> {
    const token = bearerToken(req);
    if (token !== null) {
        if (token.startsWith('dtr_live_')) {
            const apiUser = await ApiKeyService.authenticateToken(token);
            if (!apiUser) throw new AuthTokenError('Invalid or expired Datran API key');
            setRequestUser(apiUser.id);
            return { id: apiUser.id, role: 'user', via: 'bearer' };
        }

        const claims = await verifyAccessToken(token);
        if (!claims) throw new AuthTokenError();
        setRequestUser(claims.userId);
        return { id: claims.userId, role: claims.role, via: 'bearer' };
    }
    const session = await getServerSession(authOptions);
    const id = session?.user?.id;
    if (!id) return null;
    return { id, role: session.user.role || 'user', via: 'session' };
}

export function authErrorResponse(e: AuthTokenError = new AuthTokenError()): NextResponse {
    return NextResponse.json(
        { success: false, error: 'invalid_token', code: 'INVALID_TOKEN', message: e.message },
        { status: 401, headers: { 'WWW-Authenticate': 'Bearer error="invalid_token"', 'Cache-Control': 'no-store' } },
    );
}

/** getRequestUser for routes that require a user: a RequestUser, or the 401 response to return. */
export async function requireRequestUser(req: Request): Promise<RequestUser | NextResponse> {
    try {
        const user = await getRequestUser(req);
        if (user) return user;
        return NextResponse.json({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
    } catch (e) {
        if (e instanceof AuthTokenError) return authErrorResponse(e);
        throw e;
    }
}
