import type { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { hmacSign, hmacVerify } from '@/lib/security';

/**
 * Lobby participant secrets. Stateless: token = HMAC(appSecret, "lobby:<id>:<role>"),
 * delivered as an httpOnly cookie so the existing client code works unchanged.
 */

export type LobbyRole = 'creator' | 'joiner';

const COOKIE_PREFIX = 'lobby_';

function payload(lobbyId: string, role: LobbyRole) {
    return `lobby:${lobbyId}:${role}`;
}

export function setLobbyRoleCookie(res: NextResponse, lobbyId: string, role: LobbyRole) {
    res.cookies.set(`${COOKIE_PREFIX}${lobbyId}`, `${role}.${hmacSign(payload(lobbyId, role))}`, {
        httpOnly: true,
        sameSite: 'strict',
        secure: process.env.NODE_ENV === 'production',
        path: '/api/lobby',
        maxAge: 60 * 60,
    });
}

/** Returns the caller's verified role in this lobby, or null. */
export async function getLobbyRole(lobbyId: string): Promise<LobbyRole | null> {
    const jar = await cookies();
    const raw = jar.get(`${COOKIE_PREFIX}${lobbyId}`)?.value;
    if (!raw) return null;
    const dot = raw.indexOf('.');
    if (dot <= 0) return null;
    const role = raw.slice(0, dot);
    const sig = raw.slice(dot + 1);
    if (role !== 'creator' && role !== 'joiner') return null;
    return hmacVerify(payload(lobbyId, role), sig) ? role : null;
}
