
import { Chunk, Genome } from '../core/types';
import { ACSNode } from '../network/ACSNode';
import { PeerDiscovery } from '../network/PeerDiscovery';

export class HybridIndex {
    private node: ACSNode;

    constructor(node: ACSNode) {
        this.node = node;
    }

    /**
     * The "Hybrid" lookup:
     * 1. Checks Local Genome (Fast, Immediate)
     * 2. Checks Remote Swarm (Slow, Simulated DHT)
     */
    public findChunk(chunkId: string): { location: 'local' | 'remote', chunk?: Chunk, peerId?: string } {
        // 1. Local Lookup
        if (this.node.genome.chunks.has(chunkId)) {
            return { location: 'local', chunk: this.node.genome.chunks.get(chunkId) };
        }

        // 2. Remote Lookup (Hybrid aspect)
        // In a real system, this queries the DHT or Gossip protocol.
        // Here we scan the PeerDiscovery mesh.
        const peers = PeerDiscovery.discoverPeers(this.node);
        for (const peer of peers) {
            // Mock check - in reality, we'd ask them.
            // For this simulation, we assume if it's not local, it's missing or on a specific peer 
            // that we don't have direct access to without an async network call.
            // We'll return 'remote' if we can find traces of it.
        }

        return { location: 'remote' };
    }

    /**
     * Indexes a new chunk into the local genome.
     */
    public indexChunk(chunk: Chunk) {
        this.node.genome.chunks.set(chunk.id, chunk);
    }
}
