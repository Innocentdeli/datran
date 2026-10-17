import { getKV, type KV } from './kv';
import { randomToken, safeEqual } from './security';

/**
 * Swarm signaling state on the shared KV (Redis when REDIS_URL is set), so peers connected to different app
 * instances can find and signal each other.
 *
 *   swarm:peer:<peerId>    JSON { shareId, token }          TTL PEER_TTL_MS, refreshed on every authenticated call
 *   swarm:members:<share>  live set peerId -> lastSeen       bounded MAX_PEERS_PER_SWARM
 *   swarm:all              live set peerId -> lastSeen       bounded MAX_PEERS_TOTAL
 *   swarm:mb:<peerId>      list of JSON signals             bounded MAX_MESSAGES_PER_MAILBOX, TTL MESSAGE_TTL_MS
 *
 * Security properties (unchanged from the in-memory version):
 *  - Peer secrets are random, compared in constant time (safeEqual), never derivable from the peer id.
 *  - Peer id ownership is claimed with SET NX: two instances cannot both hand out a secret for one live id.
 *  - Signals only go to live peers of the same swarm; `from` is always the authenticated sender.
 *  - Mailbox drain is atomic (a message is delivered at most once); all structures are bounded and expire.
 */

export const PEER_TTL_MS = 30_000;
export const MESSAGE_TTL_MS = 60_000;
export const MAX_PEERS_TOTAL = 10_000;
export const MAX_PEERS_PER_SWARM = 50;
export const MAX_MESSAGES_PER_MAILBOX = 100;

export interface PeerRecord {
    shareId: string;
    token: string;
}

export interface SignalMessage {
    from: string;
    signal: unknown;
    timestamp: number;
}

const peerKey = (id: string) => `swarm:peer:${id}`;
const membersKey = (shareId: string) => `swarm:members:${shareId}`;
const ALL_KEY = 'swarm:all';
const mailboxKey = (id: string) => `swarm:mb:${id}`;
// Live sets expire on their own if nobody refreshes them.
const SET_TTL_MS = PEER_TTL_MS * 4;

function parsePeer(raw: string | null): PeerRecord | null {
    if (!raw) return null;
    try {
        const p = JSON.parse(raw) as PeerRecord;
        return typeof p?.shareId === 'string' && typeof p?.token === 'string' ? p : null;
    } catch {
        return null;
    }
}

export async function getPeer(peerId: string, kv: KV = getKV()): Promise<PeerRecord | null> {
    return parsePeer(await kv.get(peerKey(peerId)));
}

export function authenticatePeer(peer: PeerRecord | null, token: string | null): peer is PeerRecord {
    return !!peer && !!token && safeEqual(peer.token, token);
}

export async function livePeersInSwarm(shareId: string, kv: KV = getKV()): Promise<string[]> {
    return kv.zMembers(membersKey(shareId), Date.now() - PEER_TTL_MS);
}

export type JoinResult =
    | { ok: true; token: string; peers: string[] }
    | { ok: false; reason: 'in_use' | 'registry_full' | 'swarm_full' };

/** First announce of a peer id: claims it atomically and issues a fresh secret. */
export async function joinSwarm(peerId: string, shareId: string, kv: KV = getKV()): Promise<JoinResult> {
    const now = Date.now();
    const token = randomToken(24);
    const record = JSON.stringify({ shareId, token } satisfies PeerRecord);
    if (!(await kv.setNX(peerKey(peerId), record, PEER_TTL_MS))) return { ok: false, reason: 'in_use' };

    const others = (await livePeersInSwarm(shareId, kv)).filter((p) => p !== peerId);
    if (!(await kv.zAddCapped(ALL_KEY, peerId, now, now - PEER_TTL_MS, MAX_PEERS_TOTAL, SET_TTL_MS))) {
        await kv.delIfEquals(peerKey(peerId), record);
        return { ok: false, reason: 'registry_full' };
    }
    if (!(await kv.zAddCapped(membersKey(shareId), peerId, now, now - PEER_TTL_MS, MAX_PEERS_PER_SWARM, SET_TTL_MS))) {
        await kv.zRem(ALL_KEY, peerId);
        await kv.delIfEquals(peerKey(peerId), record);
        return { ok: false, reason: 'swarm_full' };
    }
    await kv.del(mailboxKey(peerId)); // stale messages for a previous holder of this id
    return { ok: true, token, peers: others };
}

/** Refreshes an authenticated peer (and moves it to `shareId` if it changed). Returns false if the swarm is full. */
export async function touchPeer(peerId: string, peer: PeerRecord, shareId: string, kv: KV = getKV()): Promise<boolean> {
    const now = Date.now();
    if (!(await kv.zAddCapped(membersKey(shareId), peerId, now, now - PEER_TTL_MS, MAX_PEERS_PER_SWARM, SET_TTL_MS))) return false;
    if (peer.shareId !== shareId) await kv.zRem(membersKey(peer.shareId), peerId);
    await kv.zAddCapped(ALL_KEY, peerId, now, now - PEER_TTL_MS, Number.MAX_SAFE_INTEGER, SET_TTL_MS);
    await kv.set(peerKey(peerId), JSON.stringify({ shareId, token: peer.token } satisfies PeerRecord), PEER_TTL_MS);
    return true;
}

export async function sendSignal(from: string, to: string, signal: unknown, kv: KV = getKV()): Promise<void> {
    const msg: SignalMessage = { from, signal, timestamp: Date.now() };
    await kv.listPush(mailboxKey(to), JSON.stringify(msg), MAX_MESSAGES_PER_MAILBOX, MESSAGE_TTL_MS);
}

/** Atomically drains a mailbox, dropping messages older than MESSAGE_TTL_MS. */
export async function drainSignals(peerId: string, kv: KV = getKV()): Promise<SignalMessage[]> {
    const now = Date.now();
    const out: SignalMessage[] = [];
    for (const raw of await kv.listDrain(mailboxKey(peerId))) {
        try {
            const m = JSON.parse(raw) as SignalMessage;
            if (now - m.timestamp < MESSAGE_TTL_MS) out.push(m);
        } catch { /* skip corrupt entry */ }
    }
    return out;
}
