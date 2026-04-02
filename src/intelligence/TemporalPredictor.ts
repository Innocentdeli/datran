
export interface Prediction {
    chunkId: string;
    targetRegion: string;
    confidence: number; // 0.0 - 1.0
}

export class TemporalPredictor {

    // chunkId -> Hour (0-23) -> Access History (Counts)
    private accessMatrix: Map<string, number[]> = new Map();
    // chunkId -> Region -> AccessCount
    private geoMatrix: Map<string, Map<string, number>> = new Map();
    
    // Total accesses globally
    private totalAccesses = 0;

    /**
     * Records an access at a specific time and region.
     */
    public recordAccess(chunkId: string, timestamp: number, region: string = 'global') {
        const date = new Date(timestamp);
        const hour = date.getHours();
        this.totalAccesses++;

        // 1. Temporal Tracking
        if (!this.accessMatrix.has(chunkId)) {
            this.accessMatrix.set(chunkId, new Array(24).fill(0));
        }
        const vector = this.accessMatrix.get(chunkId)!;
        vector[hour] += 1;

        // 2. Geographic Tracking
        if (!this.geoMatrix.has(chunkId)) {
            this.geoMatrix.set(chunkId, new Map());
        }
        const regionMap = this.geoMatrix.get(chunkId)!;
        regionMap.set(region, (regionMap.get(region) || 0) + 1);

        // Simple normalization/decay: If specific hour spike is too high, damp it
        if (vector[hour] > 50) {
            for(let i=0; i<24; i++) vector[i] = Math.floor(vector[i] * 0.95);
        }
    }

    /**
     * Returns the statistical confidence that a chunk will be requested in the next hour.
     * Uses a simplified Bayesian approach: P(Chunk|Hour)
     */
    public getConfidence(chunkId: string, targetHour: number): number {
        const vector = this.accessMatrix.get(chunkId);
        if (!vector) return 0;

        const hourHits = vector[targetHour];
        const totalChunkHits = vector.reduce((a, b) => a + b, 0);

        if (totalChunkHits === 0) return 0;

        // Hour Probability: How much of this chunk's traffic happens at this hour?
        const hourAffinity = hourHits / totalChunkHits;
        
        // Volume Factor: Low volume data is less predictable.
        const volumeFactor = Math.min(1.0, totalChunkHits / 10);

        return hourAffinity * volumeFactor;
    }

    /**
     * Returns a list of chunks that are statistically likely to be needed 
     * in the next hour, and their most probable request region for Edge Caching.
     */
    public predictNeeds(timestamp: number): Prediction[] {
        const date = new Date(timestamp);
        const nextHour = (date.getHours() + 1) % 24;

        const predictions: Prediction[] = [];

        for (const [chunkId, vector] of this.accessMatrix.entries()) {
            const confidence = this.getConfidence(chunkId, nextHour);
            
            // Threshold: If confidence > 40%, we consider it a hot-push candidate.
            if (confidence > 0.4) {
                const regionMap = this.geoMatrix.get(chunkId);
                let targetRegion = 'global';
                let maxRegionCount = 0;

                if (regionMap) {
                    for (const [reg, regCount] of regionMap.entries()) {
                        if (regCount > maxRegionCount) {
                            maxRegionCount = regCount;
                            targetRegion = reg;
                        }
                    }
                }

                predictions.push({ chunkId, targetRegion, confidence });
            }
        }

        // Sort by confidence so we prioritize most certain pushes
        return predictions.sort((a, b) => b.confidence - a.confidence);
    }
}
