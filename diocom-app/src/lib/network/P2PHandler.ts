/**
 * Swarm P2P handler: one WebRTC data channel between two viewers of the same share.
 *
 * Signaling goes through /api/swarm/announce (announce, signal, get-signals; authenticated
 * with the per-peer token that announce issues). Media/data never touches the server.
 *
 * Connection rule: the peer that joins later initiates (it is the only side that knows about
 * the other from the announce response), which avoids offer glare.
 *
 * There is no WebTransport/QUIC path here: no such server exists for the app, so the only
 * peer transport is a WebRTC data channel. getStatus().transport is read from getStats()
 * once the channel is open, never assumed.
 */

import { describeWebRTCTransport, getWebRTCTransportInfo } from './transportInfo';

export type P2PState = 'idle' | 'announcing' | 'waiting' | 'connecting' | 'connected' | 'failed' | 'closed';

export interface P2PStatus {
    state: P2PState;
    /** Measured transport label when connected, otherwise null. */
    transport: string | null;
    remotePeer: string | null;
}

type SignalPayload = { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit };
type IncomingSignal = { from: string; signal: SignalPayload };

const POLL_MS = 3000;
const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_BUFFERED = 4 * 1024 * 1024;

export class P2PHandler {
    private readonly shareId: string;
    private readonly peerId: string;
    private peerToken: string | null = null;
    private pc: RTCPeerConnection | null = null;
    private channel: RTCDataChannel | null = null;
    private remotePeer: string | null = null;
    private pendingCandidates: RTCIceCandidateInit[] = [];
    private pollTimer: ReturnType<typeof setInterval> | null = null;
    private polling = false;
    private status: P2PStatus = { state: 'idle', transport: null, remotePeer: null };
    private readonly onStatus?: (s: P2PStatus) => void;
    private resolveConnected: (() => void) | null = null;
    private readonly connected: Promise<void>;
    private readonly onPageHide = () => this.destroy();

    constructor(shareId: string, options: { onStatus?: (s: P2PStatus) => void } = {}) {
        this.shareId = shareId;
        this.onStatus = options.onStatus;
        const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
            : Math.random().toString(36).slice(2, 12);
        this.peerId = `peer-${rand}`;
        this.connected = new Promise<void>(resolve => { this.resolveConnected = resolve; });
    }

    /**
     * Registers with the swarm and starts signaling. The returned promise resolves only once a
     * WebRTC data channel to another viewer is actually open (it stays pending while alone).
     * It never rejects; failures are reported through getStatus()/onStatus and the console.
     */
    public initialize(): Promise<void> {
        if (this.status.state !== 'idle') return this.connected;
        if (typeof window === 'undefined' || typeof RTCPeerConnection === 'undefined') {
            this.setStatus({ state: 'failed' });
            return this.connected;
        }
        window.addEventListener('pagehide', this.onPageHide);
        this.setStatus({ state: 'announcing' });
        this.announce().catch(err => {
            console.warn('[P2P] swarm announce failed:', err);
            this.setStatus({ state: 'failed' });
        });
        return this.connected;
    }

    public getStatus(): P2PStatus {
        return { ...this.status };
    }

    /** Stops polling and closes the peer connection. Safe to call more than once. */
    public destroy() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
        this.channel?.close();
        this.pc?.close();
        this.channel = null;
        this.pc = null;
        if (this.status.state !== 'closed') this.setStatus({ state: 'closed', transport: null });
    }

    /** Sends a chunk over the open data channel. Returns false if no channel is open. */
    public async broadcastChunk(chunk: Uint8Array): Promise<boolean> {
        const ch = this.channel;
        if (!ch || ch.readyState !== 'open') return false;
        if (ch.bufferedAmount > MAX_BUFFERED) {
            await new Promise<void>(resolve => {
                ch.bufferedAmountLowThreshold = MAX_BUFFERED / 2;
                ch.addEventListener('bufferedamountlow', () => resolve(), { once: true });
                ch.addEventListener('close', () => resolve(), { once: true });
            });
            if (ch.readyState !== 'open') return false;
        }
        ch.send(chunk.slice().buffer);
        return true;
    }

    // --- signaling ---------------------------------------------------------------------------

    private async api(action: string, data?: unknown): Promise<Record<string, unknown>> {
        const res = await fetch('/api/swarm/announce', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shareId: this.shareId, peerId: this.peerId, peerToken: this.peerToken ?? undefined, action, data }),
        });
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error(`${action}: HTTP ${res.status} ${String(body.message ?? '')}`.trim());
        return body;
    }

    private async announce() {
        const data = await this.api('announce');
        if (typeof data.peerToken === 'string') this.peerToken = data.peerToken;
        if (this.status.state === 'closed') return;
        this.pollTimer = setInterval(() => void this.pollSignals(), POLL_MS);
        const peers = Array.isArray(data.peers) ? data.peers.filter((p): p is string => typeof p === 'string') : [];
        if (peers.length > 0) {
            await this.initiateConnection(peers[0]);
        } else {
            this.setStatus({ state: 'waiting' });
        }
    }

    private async pollSignals() {
        if (this.polling || !this.pollTimer) return;
        this.polling = true;
        try {
            const data = await this.api('get-signals');
            const signals = Array.isArray(data.signals) ? (data.signals as IncomingSignal[]) : [];
            for (const s of signals) await this.handleSignal(s);
        } catch (err) {
            // 403 means our registration expired (e.g. the tab slept past the TTL): stop.
            console.warn('[P2P] signaling stopped:', err);
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.pollTimer = null;
            if (this.status.state !== 'connected') this.setStatus({ state: 'failed' });
        } finally {
            this.polling = false;
        }
    }

    private async sendSignal(signal: SignalPayload) {
        if (!this.remotePeer) return;
        try {
            await this.api('signal', { to: this.remotePeer, signal });
        } catch (err) {
            console.warn('[P2P] signal send failed:', err);
        }
    }

    private async handleSignal(msg: IncomingSignal) {
        if (!msg || typeof msg.from !== 'string' || !msg.signal) return;
        // One peer connection at a time; ignore other peers once paired.
        if (this.remotePeer && msg.from !== this.remotePeer) return;
        if (!this.pc) {
            if (!msg.signal.sdp || msg.signal.sdp.type !== 'offer') return;
            this.createPeerConnection(msg.from);
        }
        const pc = this.pc!;
        try {
            if (msg.signal.sdp) {
                await pc.setRemoteDescription(msg.signal.sdp);
                for (const c of this.pendingCandidates.splice(0)) await pc.addIceCandidate(c);
                if (msg.signal.sdp.type === 'offer') {
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    await this.sendSignal({ sdp: pc.localDescription!.toJSON() });
                }
            } else if (msg.signal.candidate) {
                if (pc.remoteDescription) await pc.addIceCandidate(msg.signal.candidate);
                else this.pendingCandidates.push(msg.signal.candidate);
            }
        } catch (err) {
            console.warn('[P2P] failed to apply signal:', err);
        }
    }

    private createPeerConnection(remote: string) {
        this.remotePeer = remote;
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.pc = pc;
        this.setStatus({ state: 'connecting', remotePeer: remote });
        pc.onicecandidate = e => { if (e.candidate) void this.sendSignal({ candidate: e.candidate.toJSON() }); };
        pc.ondatachannel = e => this.setupChannel(e.channel);
        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'failed') this.setStatus({ state: 'failed', transport: null });
            else if (pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
                if (this.status.state === 'connected') this.setStatus({ state: 'closed', transport: null });
            }
        };
    }

    private async initiateConnection(remote: string) {
        this.createPeerConnection(remote);
        const pc = this.pc!;
        this.setupChannel(pc.createDataChannel('datran'));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await this.sendSignal({ sdp: pc.localDescription!.toJSON() });
    }

    private setupChannel(channel: RTCDataChannel) {
        this.channel = channel;
        channel.binaryType = 'arraybuffer';
        channel.onopen = async () => {
            const info = this.pc ? await getWebRTCTransportInfo(this.pc) : null;
            const transport = describeWebRTCTransport(info);
            console.log(`[P2P] connected to ${this.remotePeer}: ${transport}`);
            this.setStatus({ state: 'connected', transport });
            this.resolveConnected?.();
        };
        channel.onclose = () => {
            if (this.status.state === 'connected') this.setStatus({ state: 'closed', transport: null });
        };
    }

    private setStatus(patch: Partial<P2PStatus>) {
        this.status = { ...this.status, ...patch, remotePeer: patch.remotePeer ?? this.remotePeer };
        this.onStatus?.(this.getStatus());
    }
}
