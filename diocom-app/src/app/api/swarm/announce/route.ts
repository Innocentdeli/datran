import { NextResponse } from 'next/server';

/**
 * DATRAN SWARM DISCOVERY (SIGNALING)
 * 
 * In-memory registry for active swarm participants.
 * In a production scale-out, this would use Redis PUB/SUB.
 */

interface SwarmPeer {
    id: string;
    lastSeen: number;
}

const swarms = new Map<string, SwarmPeer[]>();
const mailboxes = new Map<string, any[]>();

// Cleanup stale peers every 60 seconds
setInterval(() => {
    const now = Date.now();
    for (const [shareId, peers] of swarms.entries()) {
        const active = peers.filter(p => now - p.lastSeen < 30000);
        if (active.length === 0) swarms.delete(shareId);
        else swarms.set(shareId, active);
    }
}, 60000);

export async function POST(request: Request) {
    const { shareId, peerId, action, data } = await request.json();

    if (!shareId || !peerId) {
        return NextResponse.json({ success: false, message: 'Invalid identity' }, { status: 400 });
    }

    if (action === 'announce') {
        let peers = swarms.get(shareId) || [];
        const existing = peers.find(p => p.id === peerId);

        if (existing) {
            existing.lastSeen = Date.now();
        } else {
            peers.push({ id: peerId, lastSeen: Date.now() });
        }

        swarms.set(shareId, peers);

        // Return other peers for discovery
        return NextResponse.json({
            success: true,
            peers: peers.filter(p => p.id !== peerId).map(p => p.id)
        });
    }

    if (action === 'signal') {
        const { to, from, signal } = data;
        let mailbox = mailboxes.get(to) || [];
        mailbox.push({ from, signal, timestamp: Date.now() });
        mailboxes.set(to, mailbox);
        return NextResponse.json({ success: true });
    }

    if (action === 'get-signals') {
        const mailbox = mailboxes.get(peerId) || [];
        mailboxes.set(peerId, []); // Clear mailbox
        return NextResponse.json({ success: true, signals: mailbox });
    }

    return NextResponse.json({ success: true });
}
