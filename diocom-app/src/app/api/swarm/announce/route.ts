import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { randomToken, safeEqual } from '@/lib/security';
import { enforceRateLimit } from '@/lib/rateLimit';

/**
 * DATRAN SWARM DISCOVERY (SIGNALING)
 *
 * In-memory registry for active swarm participants (single instance only;
 * a scale-out deployment would use Redis PUB/SUB).
 *
 * Security model:
 *  - On first announce a peer is issued a random secret (returned in the body as
 *    `peerToken` and set as an httpOnly cookie scoped to /api/swarm).
 *  - Every later action for that peerId (re-announce, signal, get-signals) must
 *    present the secret, so a peer can only read its own mailbox and cannot
 *    spoof the `from` field.
 *  - Signals may only be sent to peers in the same swarm.
 *  - All structures are bounded (peers, swarms, mailbox size, message TTL).
 */

interface SwarmPeer {
    id: string;
    shareId: string;
    token: string;
    lastSeen: number;
}

interface Signal {
    from: string;
    signal: unknown;
    timestamp: number;
}

const PEER_TTL_MS = 30_000;
const MESSAGE_TTL_MS = 60_000;
const MAX_PEERS_TOTAL = 10_000;
const MAX_PEERS_PER_SWARM = 50;
const MAX_MESSAGES_PER_MAILBOX = 100;
const MAX_SIGNAL_BYTES = 16 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

type SwarmState = {
    peers: Map<string, SwarmPeer>;
    mailboxes: Map<string, Signal[]>;
    timer?: ReturnType<typeof setInterval>;
};
const g = globalThis as unknown as { __diocomSwarm?: SwarmState };
const state: SwarmState = g.__diocomSwarm ?? (g.__diocomSwarm = { peers: new Map(), mailboxes: new Map() });

function sweep() {
    const now = Date.now();
    for (const [id, p] of state.peers) {
        if (now - p.lastSeen >= PEER_TTL_MS) {
            state.peers.delete(id);
            state.mailboxes.delete(id);
        }
    }
    for (const [id, box] of state.mailboxes) {
        const fresh = box.filter(m => now - m.timestamp < MESSAGE_TTL_MS);
        if (fresh.length === 0) state.mailboxes.delete(id);
        else if (fresh.length !== box.length) state.mailboxes.set(id, fresh);
    }
}

if (!state.timer) {
    state.timer = setInterval(sweep, 15_000);
    const t = state.timer as { unref?: () => void };
    if (typeof t.unref === 'function') t.unref();
}

function peersInSwarm(shareId: string): SwarmPeer[] {
    const now = Date.now();
    const out: SwarmPeer[] = [];
    for (const p of state.peers.values()) {
        if (p.shareId === shareId && now - p.lastSeen < PEER_TTL_MS) out.push(p);
    }
    return out;
}

function cookieName(peerId: string) {
    return `swarm_peer_${peerId}`;
}

async function presentedToken(peerId: string, bodyToken: unknown): Promise<string | null> {
    if (typeof bodyToken === 'string' && bodyToken) return bodyToken;
    const jar = await cookies();
    return jar.get(cookieName(peerId))?.value ?? null;
}

function authenticate(peer: SwarmPeer | undefined, token: string | null): boolean {
    return !!peer && !!token && safeEqual(peer.token, token);
}

const bad = (message: string, status = 400) => NextResponse.json({ success: false, message }, { status });

export async function POST(request: Request) {
    const limited = enforceRateLimit(request, 'swarm-announce', { maxRequests: 120, windowMs: 60_000 });
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

    const existing = state.peers.get(peerId);
    const token = await presentedToken(peerId, peerToken);

    if (action === 'announce') {
        const now = Date.now();
        if (existing && now - existing.lastSeen < PEER_TTL_MS) {
            if (!authenticate(existing, token)) return bad('Peer id in use', 403);
            existing.lastSeen = now;
            existing.shareId = shareId;
            const others = peersInSwarm(shareId).filter(p => p.id !== peerId).map(p => p.id);
            return NextResponse.json({ success: true, peers: others });
        }

        if (state.peers.size >= MAX_PEERS_TOTAL) sweep();
        if (state.peers.size >= MAX_PEERS_TOTAL) return bad('Swarm registry full', 503);
        const swarmPeers = peersInSwarm(shareId);
        if (swarmPeers.length >= MAX_PEERS_PER_SWARM) return bad('Swarm full', 503);

        const newToken = randomToken(24);
        state.peers.set(peerId, { id: peerId, shareId, token: newToken, lastSeen: now });
        state.mailboxes.delete(peerId);

        const res = NextResponse.json({
            success: true,
            peerToken: newToken,
            peers: swarmPeers.map(p => p.id),
        });
        res.cookies.set(cookieName(peerId), newToken, {
            httpOnly: true,
            sameSite: 'strict',
            secure: process.env.NODE_ENV === 'production',
            path: '/api/swarm',
            maxAge: 60 * 60,
        });
        return res;
    }

    // All other actions require an authenticated, live peer
    if (!authenticate(existing, token) || existing!.shareId !== shareId) {
        return bad('Unauthorized peer', 403);
    }
    existing!.lastSeen = Date.now();

    if (action === 'signal') {
        const { to, signal } = (data || {}) as { to?: unknown; signal?: unknown };
        if (typeof to !== 'string' || !ID_RE.test(to) || signal === undefined) return bad('Invalid signal');
        const target = state.peers.get(to);
        if (!target || target.shareId !== shareId) return bad('Unknown peer', 404);
        let size = 0;
        try {
            size = Buffer.byteLength(JSON.stringify(signal));
        } catch {
            return bad('Invalid signal');
        }
        if (size > MAX_SIGNAL_BYTES) return bad('Signal too large', 413);

        const mailbox = state.mailboxes.get(to) || [];
        if (mailbox.length >= MAX_MESSAGES_PER_MAILBOX) mailbox.shift();
        // `from` is always the authenticated sender, never client-supplied
        mailbox.push({ from: peerId, signal, timestamp: Date.now() });
        state.mailboxes.set(to, mailbox);
        return NextResponse.json({ success: true });
    }

    if (action === 'get-signals') {
        const now = Date.now();
        const mailbox = (state.mailboxes.get(peerId) || []).filter(m => now - m.timestamp < MESSAGE_TTL_MS);
        state.mailboxes.delete(peerId);
        return NextResponse.json({ success: true, signals: mailbox });
    }

    return bad('Invalid action');
}
