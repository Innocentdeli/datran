import type { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { hmacSign, hmacVerify } from '@/lib/security';
import { getRequestUser } from '@/lib/auth/requestUser';

/**
 * Lobby participant secrets. Stateless: token = "<role>.<HMAC(appSecret, "lobby:<id>:<role>")>".
 * Delivered two ways so every client works:
 *  - as an httpOnly cookie (web: the existing browser code works unchanged), and
 *  - in the JSON body as `token` (mobile/native clients), sent back in the `x-lobby-token` header.
 */

export type LobbyRole = 'creator' | 'joiner';

const COOKIE_PREFIX = 'lobby_';
export const LOBBY_TOKEN_HEADER = 'x-lobby-token';

function payload(lobbyId: string, role: LobbyRole) {
    return `lobby:${lobbyId}:${role}`;
}

/** The participant token for a role in a lobby (same value as the cookie). */
export function lobbyRoleToken(lobbyId: string, role: LobbyRole): string {
    return `${role}.${hmacSign(payload(lobbyId, role))}`;
}

export function setLobbyRoleCookie(res: NextResponse, lobbyId: string, role: LobbyRole) {
    res.cookies.set(`${COOKIE_PREFIX}${lobbyId}`, lobbyRoleToken(lobbyId, role), {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/api/lobby',
        maxAge: 60 * 60,
    });
}

function verifyToken(lobbyId: string, raw: string | null | undefined): LobbyRole | null {
    if (!raw) return null;
    const dot = raw.indexOf('.');
    if (dot <= 0) return null;
    const role = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    if (role !== 'creator' && role !== 'joiner') return null;
    return hmacVerify(payload(lobbyId, role), sig) ? role : null;
}

/** Returns the caller's verified role in this lobby (header token first, then cookie), or null. */
export async function getLobbyRole(lobbyId: string, req?: Request): Promise<LobbyRole | null> {
    const fromHeader = verifyToken(lobbyId, req?.headers.get(LOBBY_TOKEN_HEADER));
    if (fromHeader) return fromHeader;
    const jar = await cookies();
    return verifyToken(lobbyId, jar.get(`${COOKIE_PREFIX}${lobbyId}`)?.value);
}

/** Optional caller identity (bearer token or web session). Lobbies work without an account, so errors -> null. */
export async function optionalUserId(req: Request): Promise<string | null> {
    try {
        return (await getRequestUser(req))?.id ?? null;
    } catch {
        return null;
    }
}
