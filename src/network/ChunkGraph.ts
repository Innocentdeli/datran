
export class ChunkGraph {

    // correlation[chunkA][chunkB] = count
    private correlations: Map<string, Map<string, number>> = new Map();

    public recordTransition(fromChunkId: string, toChunkId: string) {
        if (!this.correlations.has(fromChunkId)) {
            this.correlations.set(fromChunkId, new Map());
        }
        const neighbors = this.correlations.get(fromChunkId)!;
        const current = neighbors.get(toChunkId) || 0;
        neighbors.set(toChunkId, current + 1);
    }

    public getCorrelatedChunks(chunkId: string): string[] {
        const neighbors = this.correlations.get(chunkId);
        if (!neighbors) return [];

        // Sort by frequency
        return Array.from(neighbors.entries())
            .sort((a, b) => b[1] - a[1])
            .map(entry => entry[0]);
    }
}
