
import { ACSNode } from './ACSNode';
import { Peer } from '../core/types';

export class PeerDiscovery {
    private static network: ACSNode[] = [];

    public static register(node: ACSNode) {
        this.network.push(node);
    }

    public static discoverPeers(node: ACSNode): Peer[] {
        // Return all other nodes as peers (Full Mesh for sim)
        return this.network
            .filter(n => n.id !== node.id)
            .map(n => ({
                id: n.id,
                region: n.region,
                latency: Math.random() * 100, // Random latency
                reliability: 0.99
            }));
    }
}
