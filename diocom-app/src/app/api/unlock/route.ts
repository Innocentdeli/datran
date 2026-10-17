import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { FileRepository } from '@/db/files';
import { getClientIp, verifyPassword } from '@/lib/security';
import { consumeRateLimit, enforceRateLimit } from '@/lib/rateLimit';
import { ACCESS_TTL_MS, accessCookieName, createAccessToken } from '@/lib/crypto/AccessToken';

const INVALID = () => NextResponse.json({ success: false, error: 'Invalid credentials' }, { status: 401 });

export async function POST(request: Request) {
    try {
        let body: unknown;
        try {
            body = await request.json();
        } catch {
            return NextResponse.json({ success: false, error: 'Bad request' }, { status: 400 });
        }
        const { shareId, password } = (body ?? {}) as { shareId?: unknown; password?: unknown };

        if (typeof shareId !== 'string' || typeof password !== 'string' || !shareId || !password
            || shareId.length > 512 || password.length > 1024) {
            return NextResponse.json({ success: false, error: 'Bad request' }, { status: 400 });
        }

        // Per-IP limit across all files, plus a tighter per-(IP, file) limit against brute force.
        const limited = await enforceRateLimit(request, 'unlock', { maxRequests: 30, windowMs: 60_000 });
        if (limited) return limited;
        const ip = getClientIp(request);
        if (!(await consumeRateLimit(`unlock:file:${ip}:${shareId}`, { maxRequests: 5, windowMs: 60_000 }))) {
            return NextResponse.json({ success: false, error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
        }

        const fileRecord = await FileRepository.findByShareId(shareId);

        // Same generic response for missing / unprotected / wrong password (no enumeration).
        if (!fileRecord || !fileRecord.password_hash) return INVALID();
        if (fileRecord.expires_at && Date.now() > Number(fileRecord.expires_at)) return INVALID();

        const ok = await verifyPassword(password, fileRecord.password_hash);
        if (!ok) return INVALID();

        const now = Date.now();
        let expiresAt = now + ACCESS_TTL_MS;
        if (fileRecord.expires_at) expiresAt = Math.min(expiresAt, Number(fileRecord.expires_at));

        const cookieStore = await cookies();
        cookieStore.set(accessCookieName(fileRecord.share_id), createAccessToken(fileRecord.share_id, expiresAt), {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            path: '/',
            maxAge: Math.max(1, Math.floor((expiresAt - now) / 1000)),
        });

        return NextResponse.json({ success: true });
    } catch (e) {
        console.error('[AUTH] Unlock error:', e instanceof Error ? e.message : e);
        return NextResponse.json({ success: false, error: 'Internal error' }, { status: 500 });
    }
}
