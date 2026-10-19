import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/app/api/auth/[...nextauth]/route';
import { setRequestUser } from '@/lib/observability';
import { verifyAccessToken } from './mobileTokens';

/**
 * The authenticated user of a request, from EITHER
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
