/**
 * Datran Warp-Speed P2P Handler
 * 
 * Orchestrates WebRTC connections between peers.
 */

export class P2PHandler {
    private peerConnection: RTCPeerConnection | null = null;
    private dataChannels: RTCDataChannel[] = [];
    private webTransport: any = null; // Use any for experimental API
    private wtWriter: any = null;
    
    private peerId: string;
    private shareId: string;
    private roundRobinIndex = 0;

    constructor(shareId: string) {
        this.shareId = shareId;
        this.peerId = 'peer-' + Math.random().toString(36).substring(2, 9);
    }

    public async initialize() {
        console.log(`[P2P] Swarm Node Active: ${this.peerId}`);
        
        // Attempt WebTransport (HTTP/3) connection
        this.initWebTransport().catch(e => console.log('[P2P] WebTransport unavailable, falling back to WebRTC multiplexing.'));

        const response = await fetch('/api/swarm/announce', {
            method: 'POST',
            body: JSON.stringify({ shareId: this.shareId, peerId: this.peerId, action: 'announce' })
        });
        const data = await response.json();
        
        // Start Signal Polling
        setInterval(() => this.pollSignals(), 3000);

        if (data.peers.length > 0) {
            const targetPeer = data.peers[0];
            // Coordinator logic: Lower ID initiates to avoid double connection
            if (this.peerId < targetPeer) {
                this.initiateConnection(targetPeer);
            }
        }
    }

    private async initWebTransport() {
        if (!('WebTransport' in window)) throw new Error('Not supported');
        // Simulated endpoint. In production, this connects to a dedicated Quic server.
        // @ts-ignore
        this.webTransport = new WebTransport('https://127.0.0.1:4433/datran-quic');
        await this.webTransport.ready;
        console.log('[P2P] ⚡ WebTransport (HTTP/3) Tunnel Engaged.');
        const stream = await this.webTransport.createUnidirectionalStream();
        this.wtWriter = stream.getWriter();
    }

    private async pollSignals() {
        const res = await fetch('/api/swarm/announce', {
            method: 'POST',
            body: JSON.stringify({ shareId: this.shareId, peerId: this.peerId, action: 'get-signals' })
        });
        const { signals } = await res.json();
        for (const signal of signals) {
            await this.handleSignal(signal);
        }
    }

    private async handleSignal(msg: any) {
        if (!this.peerConnection) this.createPeerConnection(msg.from);

        if (msg.signal.sdp) {
            await this.peerConnection!.setRemoteDescription(new RTCSessionDescription(msg.signal.sdp));
            if (msg.signal.sdp.type === 'offer') {
                const answer = await this.peerConnection!.createAnswer();
                await this.peerConnection!.setLocalDescription(answer);
                this.sendSignal(msg.from, { sdp: answer });
            }
        } else if (msg.signal.candidate) {
            await this.peerConnection!.addIceCandidate(new RTCIceCandidate(msg.signal.candidate));
        }
    }

    private createPeerConnection(targetId: string) {
        this.peerConnection = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        this.peerConnection.onicecandidate = (e) => e.candidate && this.sendSignal(targetId, { candidate: e.candidate });
        this.peerConnection.ondatachannel = (e) => this.setupDataChannel(e.channel);
    }

    private async initiateConnection(targetId: string) {
        this.createPeerConnection(targetId);
        
        // Multi-Path: Create 3 parallel data channels for striped transfers
        for (let i = 0; i < 3; i++) {
            const dc = this.peerConnection!.createDataChannel(`datran-stream-${i}`);
            this.setupDataChannel(dc);
        }

        const offer = await this.peerConnection!.createOffer();
        await this.peerConnection!.setLocalDescription(offer);
        this.sendSignal(targetId, { sdp: offer });
    }

    private async sendSignal(to: string, signal: any) {
        await fetch('/api/swarm/announce', {
            method: 'POST',
            body: JSON.stringify({ shareId: this.shareId, peerId: this.peerId, action: 'signal', data: { to, from: this.peerId, signal } })
        });
    }

    private setupDataChannel(channel: RTCDataChannel) {
        this.dataChannels.push(channel);
        channel.onopen = () => console.log(`[P2P] Warp Tunnel Open (Path ${this.dataChannels.length}).`);
        channel.onmessage = (e) => console.log('[P2P] Received Swarm Payload:', e.data.byteLength);
    }

    public async broadcastChunk(chunk: Uint8Array) {
        // Multi-Path Striping
        if (this.wtWriter) {
            // Prefer WebTransport if available
            await this.wtWriter.write(chunk);
            return;
        }

        const openChannels = this.dataChannels.filter(c => c.readyState === 'open');
        if (openChannels.length > 0) {
            // Stripe across WebRTC channels
            const channel = openChannels[this.roundRobinIndex % openChannels.length];
            channel.send(chunk.buffer as ArrayBuffer);
            this.roundRobinIndex++;
        }
    }
}
