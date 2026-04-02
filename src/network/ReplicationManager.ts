
import { Chunk, Peer, NetworkMessage } from '../core/types';
import { ACSNode } from '../network/ACSNode';

export class ReplicationManager {

    private node: ACSNode;
    private peers: Map<string, Peer> = new Map();

    // Short-term stats to trigger "Burst" replication
    private transientMap: Map<string, Map<string, number>> = new Map();

    // Long-term stats to trigger "Migration" (Gravity)
    private gravityMap: Map<string, Map<string, number>> = new Map();

    constructor(node: ACSNode) {
        this.node = node;
    }

    public addPeer(peer: Peer) {
        this.peers.set(peer.id, peer);
    }

    public recordRequest(chunkId: string, region: string) {
        // Update Transient
        if (!this.transientMap.has(chunkId)) this.transientMap.set(chunkId, new Map());
        const tMap = this.transientMap.get(chunkId)!;
        tMap.set(region, (tMap.get(region) || 0) + 1);

        // Update Gravity
        if (!this.gravityMap.has(chunkId)) this.gravityMap.set(chunkId, new Map());
        const gMap = this.gravityMap.get(chunkId)!;
        gMap.set(region, (gMap.get(region) || 0) + 1);

        this.checkThresholds(chunkId);
    }

    private checkThresholds(chunkId: string) {
        const chunk = this.node.genome.chunks.get(chunkId);
        if (!chunk) return;

        // 1. REPLICATION CHECK (Transient)
        const tMap = this.transientMap.get(chunkId)!;
        for (const [region, count] of tMap.entries()) {
            if (count > 5) {
                this.replicateToRegion(chunk, region);
                tMap.set(region, 0); // Reset only transient
            }
        }

        // 2. MIGRATION CHECK (Gravity - Long Term)
        const gMap = this.gravityMap.get(chunkId)!;
        let totalRequests = 0;
        let maxRegion = '';
        let maxCount = 0;

        for (const [region, count] of gMap.entries()) {
            totalRequests += count;
            if (count > maxCount) {
                maxCount = count;
                maxRegion = region;
            }
        }

        if (totalRequests > 20 && maxRegion !== this.node.region) {
            if ((maxCount / totalRequests) > 0.8) {
                this.migrateToRegion(chunk, maxRegion);
                gMap.clear(); // Reset gravity after migrate
                // Also clear transient to avoid weird state
                tMap.clear();
            }
        }
    }

    private replicateToRegion(chunk: Chunk, region: string) {
        if (region === this.node.region) return;
        // console.log(`[Swarm] Replicating Chunk ${chunk.id.substr(0,8)} to Region ${region}`);
    }

    private migrateToRegion(chunk: Chunk, region: string) {
        console.log(`[Gravity] 🚀 Moving Chunk ${chunk.id.substr(0, 8)} to ${region} (Source: ${this.node.region})`);
    }

    public receiveReplication(chunkId: string, data: Buffer, variantId: string) {
    }

    /**
     * SELF-HEALING: RESILIENCE LOOP
     */
    public startResilienceLoop() {
        setInterval(async () => {
            console.log(`[Mesh] 🛡️ Resilience Check: Scanning neighbor health...`);

            try {
                // In Node.js environment, we need an absolute URL
                const baseUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || 'http://localhost:3000';
                const pulseUrl = baseUrl.endsWith('/') ? `${baseUrl}api/swarm/pulse` : `${baseUrl}/api/swarm/pulse`;

                // 1. Get Node Pulse through the API (simulated here)
                const response = await fetch(pulseUrl, {
                    method: 'POST',
                    body: JSON.stringify({ nodeId: this.node.id, region: this.node.region })
                });

                if (response.ok) {
                    const { activeNodes } = await response.json();
                    if (activeNodes < 2) {
                        console.log(`[Mesh] ⚠️ Critical Resilience Alert: Node isolation detected.`);
                    }
                }
            } catch (error) {
                console.error(`[Mesh] ❌ Resilience Check failed:`, error instanceof Error ? error.message : error);
            }
        }, 15000);
    }
}
