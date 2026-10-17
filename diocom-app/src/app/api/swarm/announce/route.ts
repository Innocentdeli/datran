import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { enforceRateLimit } from '@/lib/rateLimit';
import {
    getPeer, authenticatePeer, joinSwarm, touchPeer, livePeersInSwarm, sendSignal, drainSignals,
} from '@/lib/swarmSignaling';

/**
 * DATRAN SWARM DISCOVERY (SIGNALING)
 *
 * Registry + mailboxes live in the shared KV (src/lib/swarmSignaling.ts; Redis when REDIS_URL is set), so peers
 * on different app instances can discover and signal each other.
 *
 * Security model:
 *  - On first announce a peer is issued a random secret (returned in the body as
 *    `peerToken` and set as an httpOnly cookie scoped to /api/swarm).
 *  - Every later action for that peerId (re-announce, signal, get-signals) must
 *    present the secret (constant-time compare), so a peer can only read its own
 *    mailbox and cannot spoof the `from` field.
 *  - Signals may only be sent to peers in the same swarm.
 *  - All structures are bounded (peers, swarms, mailbox size, message TTL).
 */

const MAX_SIGNAL_BYTES = 16 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function cookieName(peerId: string) {
    return `swarm_peer_${peerId}`;
}

async function presentedToken(peerId: string, bodyToken: unknown): Promise<string | null> {
    if (typeof bodyToken === 'string' && bodyToken) return bodyToken;
    const jar = await cookies();
    return jar.get(cookieName(peerId))?.value ?? null;
}

const bad = (message: string, status = 400) => NextResponse.json({ success: false, message }, { status });

export async function POST(request: Request) {
    const limited = await enforceRateLimit(request, 'swarm-announce', { maxRequests: 120, windowMs: 60_000 });
    if (limited) return limited;

    let body: Record<string, unknown>;
    try {
        body = await request.json();
    } catch {
        return bad('Invalid request');
    }
    const { shareId, peerId, action, data, peerToken } = body as {
        shareId?: unknown; peerId?: unknown; action?: unknown; data?: unknown; peerToken?: unknown;
    };

    if (typeof shareId !== 'string' || typeof peerId !== 'string' || !ID_RE.test(shareId) || !ID_RE.test(peerId)) {
        return bad('Invalid identity');
    }

    try {
        return await handle(peerId, shareId, action, data, peerToken);
    } catch (e) {
        console.error('[swarm/announce]', e instanceof Error ? e.message : e);
        return bad('Signaling unavailable', 503);
    }
}

async function handle(peerId: string, shareId: string, action: unknown, data: unknown, peerToken: unknown) {
    const existing = await getPeer(peerId);
    const token = await presentedToken(peerId, peerToken);

    if (action === 'announce') {
        if (existing) {
            if (!authenticatePeer(existing, token)) return bad('Peer id in use', 403);
            if (!(await touchPeer(peerId, existing, shareId))) return bad('Swarm full', 503);
            const others = (await livePeersInSwarm(shareId)).filter(p => p !== peerId);
            return NextResponse.json({ success: true, peers: others });
        }

        const joined = await joinSwarm(peerId, shareId);
        if (!joined.ok) {
            if (joined.reason === 'in_use') return bad('Peer id in use', 403);
            return bad(joined.reason === 'registry_full' ? 'Swarm registry full' : 'Swarm full', 503);
        }

        const res = NextResponse.json({
            success: true,
            peerToken: joined.token,
            peers: joined.peers,
        });
        res.cookies.set(cookieName(peerId), joined.token, {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
            path: '/api/swarm',
            maxAge: 60 * 60,
        });
        return res;
    }

    // All other actions require an authenticated, live peer
    if (!authenticatePeer(existing, token) || existing.shareId !== shareId) {
        return bad('Unauthorized peer', 403);
    }
    await touchPeer(peerId, existing, shareId);

    if (action === 'signal') {
        const { to, signal } = (data || {}) as { to?: unknown; signal?: unknown };
        if (typeof to !== 'string' || !ID_RE.test(to) || signal === undefined) return bad('Invalid signal');
        const target = await getPeer(to);
        if (!target || target.shareId !== shareId) return bad('Unknown peer', 404);
        let size = 0;
        try {
            size = Buffer.byteLength(JSON.stringify(signal));
        } catch {
            return bad('Invalid signal');
        }
        if (size > MAX_SIGNAL_BYTES) return bad('Signal too large', 413);

        // `from` is always the authenticated sender, never client-supplied
        await sendSignal(peerId, to, signal);
        return NextResponse.json({ success: true });
    }

    if (action === 'get-signals') {
        return NextResponse.json({ success: true, signals: await drainSignals(peerId) });
    }

    return bad('Invalid action');
}
