
import { Chunk, Variant } from '../core/types';
import { GenomeGenerator } from '../core/GenomeGenerator';
import * as crypto from 'crypto';

export class ChunkFuser {

    /**
     * Fuses two chunks into a new Super-Chunk.
     * This reduces overhead (1 request vs 2) and allows cross-chunk compression.
     */
    public static fuse(chunkA: Chunk, chunkB: Chunk): Chunk {
        // 1. Get best data from both (prefer Raw for fusing to avoid re-compression artifacts)
        const dataA = this.getRawOrBest(chunkA);
        const dataB = this.getRawOrBest(chunkB);

        // 2. Concatenate
        const fusedData = Buffer.concat([dataA, dataB]);

        // 3. Create ID
        const fusedId = crypto.createHash('sha256').update(fusedData).digest('hex');

        // 4. Generate Variants for the new Super-Chunk
        // The "Evolution" starts fresh for this new organism
        const variants = GenomeGenerator.generateVariants(fusedId, fusedData);

        return {
            id: fusedId,
            originalSize: fusedData.length,
            variants: variants,
            bestVariantId: variants[0].id // Baseline
        };
    }

    private static getRawOrBest(chunk: Chunk): Buffer {
        const raw = chunk.variants.find(v => v.algorithm === 'raw');
        if (raw) return raw.data;

        // If no raw (weird), decode best
        const best = chunk.variants.find(v => v.id === chunk.bestVariantId) || chunk.variants[0];

        if (best.algorithm === 'lz4') {
            const lz4 = require('lz4js');
            return Buffer.from(lz4.decompress(best.data));
        } else if (best.algorithm === 'brotli') {
            const brotli = require('brotli');
            return Buffer.from(brotli.decompress(best.data));
        }
        return best.data;
    }
}
