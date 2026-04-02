
import * as crypto from 'crypto';

export type EdgeRegion = 'us-east' | 'eu-west' | 'asia-pacific' | 'global';

interface EdgeFragment {
    chunkId: string;
    data: Buffer;
    cachedAt: number;
    ttl: number;
}

export class SwarmEdgeService {
    private static instance: SwarmEdgeService;
    
    // Region -> chunkId -> Fragment
    private edgeStorage: Map<EdgeRegion, Map<string, EdgeFragment>> = new Map();

    private constructor() {
        // Initialize regions
        const regions: EdgeRegion[] = ['us-east', 'eu-west', 'asia-pacific', 'global'];
        regions.forEach(r => this.edgeStorage.set(r, new Map()));
    }

    public static getInstance(): SwarmEdgeService {
        if (!SwarmEdgeService.instance) {
            SwarmEdgeService.instance = new SwarmEdgeService();
        }
        return SwarmEdgeService.instance;
    }

    /**
     * Pro-actively caches a chunk in a specific edge region.
     */
    public async cache(chunkId: string, data: Buffer, region: EdgeRegion = 'global', ttlMinutes: number = 60) {
        const regionMap = this.edgeStorage.get(region);
        if (!regionMap) return;

        console.log(`[SwarmEdge] ⚡ Pro-active Push: Fragment ${chunkId.substring(0,8)} -> ${region.toUpperCase()}`);

        regionMap.set(chunkId, {
            chunkId,
            data,
            cachedAt: Date.now(),
            ttl: ttlMinutes * 60 * 1000
        });

        // In a real system, this would trigger an S3 cross-region replication or Lambda@Edge push.
    }

    /**
     * Retrieves a chunk from the edge.
     */
    public get(chunkId: string, region: EdgeRegion = 'global'): Buffer | null {
        const regionMap = this.edgeStorage.get(region);
        if (!regionMap) return null;

        const fragment = regionMap.get(chunkId);
        if (!fragment) return null;

        // Check expiration
        if (Date.now() > fragment.cachedAt + fragment.ttl) {
            regionMap.delete(chunkId);
            return null;
        }

        console.log(`[SwarmEdge] 🎯 Edge Hit: ${chunkId.substring(0,8)} served from ${region.toUpperCase()}`);
        return fragment.data;
    }

    /**
     * Returns stats for the Oracle Dashboard
     */
    public getStats() {
        const stats: Record<string, number> = {};
        this.edgeStorage.forEach((map, region) => {
            stats[region] = map.size;
        });
        return stats;
    }
}
