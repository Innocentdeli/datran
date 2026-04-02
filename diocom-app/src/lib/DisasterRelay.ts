import { WebRTCService } from './WebRTCService';

/**
 * DisasterRelay
 * 
 * Implements "Disaster-Mode" for Datran Sovereign. 
 * Enables local-only discovery and mesh-syncing when the internet is unavailable.
 */
export class DisasterRelay {
    private static isLocalScanning = false;
    private static discoveryInterval: NodeJS.Timeout | null = null;

    /**
     * Activates the Disaster Mesh.
     * Uses a simulated mDNS/UDP broadcast to find local peers.
     */
    public static activate() {
        if (this.isLocalScanning) return;
        this.isLocalScanning = true;
        
        console.log('[DISASTER] Mesh Activated. Scanning local link for peers...');
        
        // Start simulated local beacon
        this.discoveryInterval = setInterval(() => {
            this.broadcastBeacon();
        }, 5000);
    }

    /**
     * Deactivates the Disaster Mesh.
     */
    public static deactivate() {
        this.isLocalScanning = false;
        if (this.discoveryInterval) {
            clearInterval(this.discoveryInterval);
            this.discoveryInterval = null;
        }
        console.log('[DISASTER] Mesh Deactivated.');
    }

    /**
     * Broadcasts a local presence beacon.
     */
    private static broadcastBeacon() {
        console.log('[DISASTER] Beacon sent. Searching subnet...');
        // In a native environment (Tauri), this would use UDP broadcast on port 5353
        // For the web simulation, we'll auto-connect to a local 'virtual' peer if detected
    }

    /**
     * Initiates a "Sync-and-Move" transfer for local peers.
     */
    public static async syncWithLocalPeer(peerId: string, files: string[]) {
        console.log(`[DISASTER] Synchronizing with local peer ${peerId}...`);
        
        // Use WebRTC directly without signalling-server intermediary
        // In Disaster-Mode, we exchange SDPs via the local-link or QR codes
        try {
            const offer = await WebRTCService.createOffer(peerId);
            console.log('[DISASTER] Handshake: Offer generated for local peer.');
            // Send offer over local-net (simulated)
        } catch (error) {
            console.error('[DISASTER] Handshake failed:', error);
        }
    }

    /**
     * Checks if we are currently in a "Disconnected Mesh" state.
     */
    public static async checkNetworkStatus(): Promise<'connected' | 'mesh-only'> {
        try {
            const res = await fetch('https://google.com', { mode: 'no-cors' });
            return 'connected';
        } catch (e) {
            console.warn('[DISASTER] Internet unreachable. Switching to Sovereign Mesh.');
            this.activate();
            return 'mesh-only';
        }
    }
}
