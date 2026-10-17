'use client';

/**
 * Manual-signaling WebRTC file transfer (copy/paste offer and answer).
 *
 * Because there is no signaling channel, ICE is non-trickle: the offer/answer are only handed
 * out after ICE gathering completes, so the pasted SDP contains every candidate.
 * The data channel is reliable and ordered (file bytes must not be dropped), and sending
 * respects bufferedAmount so large files do not overflow the SCTP send buffer.
 */

import { describeWebRTCTransport, getWebRTCTransportInfo } from '@/lib/network/transportInfo';

export interface FileMetadata {
    type: 'file-metadata';
    name: string;
    size: number;
    mimeType: string;
}

export type ManualPeerState = RTCPeerConnectionState | 'new';

export interface ManualPeerStatus {
    connection: ManualPeerState;
    channel: RTCDataChannelState | 'none';
    /** Measured once the data channel is open (selected ICE candidate pair). */
    transport: string | null;
}

const ICE_SERVERS: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
];
const CHUNK_SIZE = 64 * 1024;
const MAX_BUFFERED = 8 * 1024 * 1024;
const ICE_GATHER_TIMEOUT_MS = 10_000;

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            pc.removeEventListener('icegatheringstatechange', check);
            resolve();
        };
        const check = () => { if (pc.iceGatheringState === 'complete') done(); };
        // Some networks never reach 'complete' (unreachable STUN); use what we have.
        const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
        pc.addEventListener('icegatheringstatechange', check);
    });
}

export class ManualPeer {
    private pc: RTCPeerConnection | null = null;
    private channel: RTCDataChannel | null = null;
    private status: ManualPeerStatus = { connection: 'new', channel: 'none', transport: null };
    private incoming: { meta: FileMetadata; chunks: ArrayBuffer[]; received: number } | null = null;

    constructor(
        private readonly handlers: {
            onStatus?: (s: ManualPeerStatus) => void;
            onFileReceived?: (file: Blob, meta: FileMetadata) => void;
            onReceiveProgress?: (percent: number) => void;
        } = {},
    ) {}

    /** Initiator: returns the offer SDP (with all gathered candidates) as JSON. */
    async createOffer(): Promise<string> {
        const pc = this.reset();
        this.attachChannel(pc.createDataChannel('fileTransfer', { ordered: true }));
        await pc.setLocalDescription(await pc.createOffer());
        await waitForIceGathering(pc);
        return JSON.stringify(pc.localDescription);
    }

    /** Receiver: applies the pasted offer and returns the answer SDP as JSON. */
    async createAnswer(offerJson: string): Promise<string> {
        const offer = JSON.parse(offerJson) as RTCSessionDescriptionInit;
        if (offer?.type !== 'offer') throw new Error('Pasted text is not an offer');
        const pc = this.reset();
        pc.ondatachannel = e => this.attachChannel(e.channel);
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());
        await waitForIceGathering(pc);
        return JSON.stringify(pc.localDescription);
    }

    /** Initiator: applies the pasted answer. Connection state is reported via onStatus. */
    async acceptAnswer(answerJson: string): Promise<void> {
        const answer = JSON.parse(answerJson) as RTCSessionDescriptionInit;
        if (answer?.type !== 'answer') throw new Error('Pasted text is not an answer');
        if (!this.pc) throw new Error('Create an offer first');
        await this.pc.setRemoteDescription(answer);
    }

    async sendFile(file: File, onProgress?: (percent: number) => void): Promise<void> {
        const ch = this.channel;
        if (!ch || ch.readyState !== 'open') throw new Error('Data channel is not open');
        const meta: FileMetadata = { type: 'file-metadata', name: file.name, size: file.size, mimeType: file.type };
        ch.send(JSON.stringify(meta));
        ch.bufferedAmountLowThreshold = MAX_BUFFERED / 2;

        let offset = 0;
        while (offset < file.size) {
            if (ch.readyState !== 'open') throw new Error('Data channel closed during transfer');
            if (ch.bufferedAmount > MAX_BUFFERED) {
                await new Promise<void>(resolve => {
                    ch.addEventListener('bufferedamountlow', () => resolve(), { once: true });
                    ch.addEventListener('close', () => resolve(), { once: true });
                });
                continue;
            }
            const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            ch.send(buf);
            offset += buf.byteLength;
            onProgress?.(file.size ? Math.floor((offset / file.size) * 100) : 100);
        }
        if (file.size === 0) onProgress?.(100);
    }

    getStatus(): ManualPeerStatus {
        return { ...this.status };
    }

    close() {
        this.channel?.close();
        this.pc?.close();
        this.channel = null;
        this.pc = null;
        this.incoming = null;
    }

    private reset(): RTCPeerConnection {
        this.close();
        const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
        this.pc = pc;
        this.setStatus({ connection: 'new', channel: 'none', transport: null });
        pc.onconnectionstatechange = () => {
            this.setStatus({ connection: pc.connectionState, ...(pc.connectionState === 'connected' ? {} : { transport: null }) });
        };
        return pc;
    }

    private attachChannel(ch: RTCDataChannel) {
        this.channel = ch;
        ch.binaryType = 'arraybuffer';
        this.setStatus({ channel: ch.readyState });
        ch.onopen = async () => {
            const info = this.pc ? await getWebRTCTransportInfo(this.pc) : null;
            this.setStatus({ channel: ch.readyState, transport: describeWebRTCTransport(info) });
        };
        ch.onclose = () => this.setStatus({ channel: 'closed', transport: null });
        ch.onerror = e => console.error('[WebRTC] data channel error:', e);
        ch.onmessage = e => this.onMessage(e);
    }

    private onMessage(e: MessageEvent) {
        if (typeof e.data === 'string') {
            try {
                const meta = JSON.parse(e.data) as FileMetadata;
                if (meta?.type === 'file-metadata' && typeof meta.size === 'number' && meta.size >= 0) {
                    this.incoming = { meta, chunks: [], received: 0 };
                    this.handlers.onReceiveProgress?.(0);
                    if (meta.size === 0) this.finishIncoming();
                }
            } catch {
                console.warn('[WebRTC] ignored malformed control message');
            }
            return;
        }
        const cur = this.incoming;
        if (!cur || !(e.data instanceof ArrayBuffer)) return;
        cur.chunks.push(e.data);
        cur.received += e.data.byteLength;
        this.handlers.onReceiveProgress?.(Math.floor((cur.received / cur.meta.size) * 100));
        if (cur.received >= cur.meta.size) this.finishIncoming();
    }

    private finishIncoming() {
        const cur = this.incoming;
        if (!cur) return;
        this.incoming = null;
        const blob = new Blob(cur.chunks, { type: cur.meta.mimeType || 'application/octet-stream' });
        this.handlers.onFileReceived?.(blob, cur.meta);
    }

    private setStatus(patch: Partial<ManualPeerStatus>) {
        this.status = { ...this.status, ...patch };
        this.handlers.onStatus?.(this.getStatus());
    }
}
