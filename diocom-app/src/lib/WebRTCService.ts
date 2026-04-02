'use client';

/**
 * Phase 33: Ephemeral Wormholes - WebRTC P2P Service
 * Enables direct browser-to-browser file transfers without server intermediary
 */

export interface PeerConnection {
    id: string;
    connection: RTCPeerConnection;
    dataChannel?: RTCDataChannel;
    status: 'connecting' | 'connected' | 'disconnected';
}

export class WebRTCService {
    private static peers: Map<string, PeerConnection> = new Map();
    private static onFileReceived?: (file: Blob, metadata: any) => void;

    // STUN servers for NAT traversal
    private static iceServers = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];

    /**
     * Initialize a new peer connection
     */
    static async createPeerConnection(peerId: string): Promise<RTCPeerConnection> {
        const pc = new RTCPeerConnection({
            iceServers: this.iceServers
        });

        // Store connection
        this.peers.set(peerId, {
            id: peerId,
            connection: pc,
            status: 'connecting'
        });

        // ICE candidate handling
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log('[WebRTC] ICE Candidate:', event.candidate);
                // In production, send this to signaling server
            }
        };

        pc.onconnectionstatechange = () => {
            const peer = this.peers.get(peerId);
            if (peer) {
                if (pc.connectionState === 'connected') {
                    peer.status = 'connected';
                    console.log(`[WebRTC] Connected to peer: ${peerId}`);
                } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                    peer.status = 'disconnected';
                    console.log(`[WebRTC] Disconnected from peer: ${peerId}`);
                }
            }
        };

        return pc;
    }

    /**
     * Create data channel for file transfer
     */
    static createDataChannel(peerId: string, channelName: string = 'fileTransfer'): RTCDataChannel | null {
        const peer = this.peers.get(peerId);
        if (!peer) return null;

        const dataChannel = peer.connection.createDataChannel(channelName, {
            ordered: true,
            maxRetransmits: 3
        });

        peer.dataChannel = dataChannel;

        dataChannel.onopen = () => {
            console.log(`[WebRTC] Data channel opened: ${channelName}`);
        };

        dataChannel.onclose = () => {
            console.log(`[WebRTC] Data channel closed: ${channelName}`);
        };

        dataChannel.onerror = (error) => {
            console.error('[WebRTC] Data channel error:', error);
        };

        dataChannel.onmessage = this.handleDataChannelMessage.bind(this);

        return dataChannel;
    }

    /**
     * Send file to peer via WebRTC
     */
    static async sendFile(peerId: string, file: File, onProgress?: (percent: number) => void): Promise<void> {
        const peer = this.peers.get(peerId);
        if (!peer || !peer.dataChannel || peer.dataChannel.readyState !== 'open') {
            throw new Error('Data channel not ready');
        }

        const chunkSize = 16384; // 16KB chunks
        const totalChunks = Math.ceil(file.size / chunkSize);

        // Send metadata first
        const metadata = {
            type: 'file-metadata',
            name: file.name,
            size: file.size,
            mimeType: file.type,
            totalChunks
        };

        peer.dataChannel.send(JSON.stringify(metadata));
        console.log('[WebRTC] Sending file metadata:', metadata);

        // Send file in chunks
        const reader = new FileReader();
        let offset = 0;
        let chunkIndex = 0;

        const sendNextChunk = () => {
            const slice = file.slice(offset, offset + chunkSize);
            reader.readAsArrayBuffer(slice);
        };

        reader.onload = (e) => {
            if (e.target?.result && peer.dataChannel) {
                peer.dataChannel.send(e.target.result as ArrayBuffer);

                chunkIndex++;
                offset += chunkSize;

                if (onProgress) {
                    onProgress(Math.floor((chunkIndex / totalChunks) * 100));
                }

                if (offset < file.size) {
                    sendNextChunk();
                } else {
                    console.log('[WebRTC] File transfer complete');
                    if (onProgress) onProgress(100);

                    // Report to server for $DTN credits
                    fetch('/api/swarm/report', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            peerId,
                            fileId: file.name,
                            bytesSent: file.size,
                            status: 'complete'
                        })
                    }).then(res => res.json())
                      .then(data => console.log('[WebRTC] Swarm report successful:', data))
                      .catch(err => console.error('[WebRTC] Swarm report failed:', err));
                }
            }
        };

        sendNextChunk();
    }

    /**
     * Handle incoming data channel messages
     */
    private static handleDataChannelMessage(event: MessageEvent) {
        if (typeof event.data === 'string') {
            // Metadata message
            try {
                const metadata = JSON.parse(event.data);
                if (metadata.type === 'file-metadata') {
                    console.log('[WebRTC] Receiving file:', metadata);
                    // Initialize file reception
                    this.initFileReception(metadata);
                }
            } catch (e) {
                console.error('[WebRTC] Failed to parse metadata:', e);
            }
        } else {
            // Binary chunk
            this.receiveFileChunk(event.data);
        }
    }

    /**
     * Initialize file reception
     */
    private static currentFileReception: {
        metadata: any;
        chunks: ArrayBuffer[];
        receivedChunks: number;
    } | null = null;

    private static initFileReception(metadata: any) {
        this.currentFileReception = {
            metadata,
            chunks: [],
            receivedChunks: 0
        };
    }

    /**
     * Receive file chunk
     */
    private static receiveFileChunk(chunk: ArrayBuffer) {
        if (!this.currentFileReception) return;

        this.currentFileReception.chunks.push(chunk);
        this.currentFileReception.receivedChunks++;

        const progress = (this.currentFileReception.receivedChunks / this.currentFileReception.metadata.totalChunks) * 100;
        console.log(`[WebRTC] Receiving: ${Math.floor(progress)}%`);

        // Check if complete
        if (this.currentFileReception.receivedChunks === this.currentFileReception.metadata.totalChunks) {
            this.finalizeFileReception();
        }
    }

    /**
     * Finalize file reception
     */
    private static finalizeFileReception() {
        if (!this.currentFileReception) return;

        const blob = new Blob(this.currentFileReception.chunks, {
            type: this.currentFileReception.metadata.mimeType
        });

        console.log('[WebRTC] File received:', this.currentFileReception.metadata.name);

        if (this.onFileReceived) {
            this.onFileReceived(blob, this.currentFileReception.metadata);
        }

        // Reset
        this.currentFileReception = null;
    }

    /**
     * Set file received callback
     */
    static setOnFileReceived(callback: (file: Blob, metadata: any) => void) {
        this.onFileReceived = callback;
    }

    /**
     * Create offer (initiator)
     */
    static async createOffer(peerId: string): Promise<RTCSessionDescriptionInit> {
        const pc = await this.createPeerConnection(peerId);
        this.createDataChannel(peerId);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        return offer;
    }

    /**
     * Create answer (receiver)
     */
    static async createAnswer(peerId: string, offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
        const pc = await this.createPeerConnection(peerId);

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        // Listen for data channel
        pc.ondatachannel = (event) => {
            const peer = this.peers.get(peerId);
            if (peer) {
                peer.dataChannel = event.channel;
                event.channel.onmessage = this.handleDataChannelMessage.bind(this);
            }
        };

        return answer;
    }

    /**
     * Set remote answer
     */
    static async setRemoteAnswer(peerId: string, answer: RTCSessionDescriptionInit) {
        const peer = this.peers.get(peerId);
        if (peer) {
            await peer.connection.setRemoteDescription(new RTCSessionDescription(answer));
        }
    }

    /**
     * Close peer connection
     */
    static closePeer(peerId: string) {
        const peer = this.peers.get(peerId);
        if (peer) {
            peer.dataChannel?.close();
            peer.connection.close();
            this.peers.delete(peerId);
            console.log(`[WebRTC] Closed connection to: ${peerId}`);
        }
    }

    /**
     * Get all active peers
     */
    static getActivePeers(): PeerConnection[] {
        return Array.from(this.peers.values());
    }
}
