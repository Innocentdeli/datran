import { createHash } from 'crypto';
import { hmacSign, hmacVerify } from '@/lib/security';

/**
 * Signed, expiring access grants for password-protected shares.
 *
 * Cookie value format: `${shareId}.${expiryMs}.${hmac(shareId + '.' + expiryMs)}`
 * The share id may itself contain dots (legacy ids), so the value is parsed from the right.
 */

export const ACCESS_TTL_MS = 24 * 60 * 60 * 1000;

/** Cookie names must be RFC 6265 tokens; legacy share ids can contain arbitrary characters. */
export function accessCookieName(shareId: string): string {
    const h = createHash('sha256').update(shareId).digest('hex').slice(0, 24);
    return `diocom_access_${h}`;
}

export function createAccessToken(shareId: string, expiresAt: number): string {
    const payload = `${shareId}.${expiresAt}`;
    return `${payload}.${hmacSign(payload)}`;
}

export function verifyAccessToken(token: string | undefined | null, shareId: string, now = Date.now()): boolean {
    if (!token || typeof token !== 'string') return false;
    const sigIdx = token.lastIndexOf('.');
    if (sigIdx <= 0) return false;
    const payload = token.slice(0, sigIdx);
    const sig = token.slice(sigIdx + 1);
    const expIdx = payload.lastIndexOf('.');
    if (expIdx <= 0) return false;
    const id = payload.slice(0, expIdx);
    const expStr = payload.slice(expIdx + 1);
    if (!/^\d{1,16}$/.test(expStr)) return false;
    if (!hmacVerify(payload, sig)) return false;
    if (id !== shareId) return false;
    return Number(expStr) > now;
}

/** Minimal cookie-store shape shared by next/headers cookies() and NextRequest.cookies. */
interface CookieReader {
    get(name: string): { value: string } | undefined;
}

/**
 * True if the requester may access the file's content/metadata.
 * Files without a password are always accessible.
 */
export function hasFileAccess(
    cookieStore: CookieReader,
    file: { share_id: string; password_hash?: string | null }
): boolean {
    if (!file.password_hash) return true;
    return verifyAccessToken(cookieStore.get(accessCookieName(file.share_id))?.value, file.share_id);
}
