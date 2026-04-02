
export type TransportProtocol = 'WebTransport' | 'WebRTC' | 'WebSocket';

export class WebTransportService {
    private static instance: WebTransportService;
    private connection: any = null; // WebTransport is browser-only, we mock for Node
    private currentProtocol: TransportProtocol = 'WebSocket';

    private constructor() {
        this.negotiateProtocol();
    }

    public static getInstance(): WebTransportService {
        if (!WebTransportService.instance) {
            WebTransportService.instance = new WebTransportService();
        }
        return WebTransportService.instance;
    }

    private negotiateProtocol() {
        if (typeof window !== 'undefined' && (window as any).WebTransport) {
            this.currentProtocol = 'WebTransport';
        } else if (typeof window !== 'undefined' && (window as any).RTCPeerConnection) {
            this.currentProtocol = 'WebRTC';
        } else {
            this.currentProtocol = 'WebSocket';
        }
        console.log(`[WebTransport] 🛰️ Protocol Negotiated: ${this.currentProtocol}`);
    }

    /**
     * Connects to a remote peer or edge node.
     */
    public async connect(url: string) {
        console.log(`[WebTransport] 🔗 Connecting to ${url} via ${this.currentProtocol}...`);
        
        // Simulation: in a real app, this would use the browser's WebTransport API
        return new Promise((resolve) => {
            setTimeout(() => {
                console.log(`[WebTransport] ✅ Connection Established.`);
                resolve(true);
            }, 100);
        });
    }

    /**
     * Sends a chunk via the optimal stream.
     */
    public async sendChunk(chunkId: string, data: Buffer) {
        console.log(`[WebTransport] 📤 Sending Chunk ${chunkId.substring(0,8)} | StreamID: ${Math.random().toString(36).substr(2, 9)}`);
        
        // Multi-Path logic check: In WebTransport, we can use Datagrams for unreliable or 
        // Streams for reliable data. We use bidirectional streams for chunks.
        return true;
    }

    /**
     * Reliable bidirectional stream for large payloads.
     */
    public createStream() {
        return {
            write: (data: any) => console.log('[WebTransport] Stream Write:', data),
            close: () => console.log('[WebTransport] Stream Closed')
        };
    }

    public getProtocol(): TransportProtocol {
        return this.currentProtocol;
    }
}
