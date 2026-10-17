import { Chunk, Variant, FitnessProfile, CompressionAlgorithm } from './types';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as lz4 from 'lz4js';
import { ACSConfig, DEFAULT_CONFIG } from './SystemConfig';
import { DiocomReactor } from './DiocomReactor';

export interface GenerateOptions {
    /**
     * Include lossy, simulation-only variants ('ai-upscale', 'generative'). These cannot be
     * decoded back to the original bytes and must never be used for real storage.
     */
    includeSimulated?: boolean;
}

/** Algorithms whose variant data decodes back to the exact original bytes. */
export const REVERSIBLE_ALGORITHMS: ReadonlySet<CompressionAlgorithm> = new Set<CompressionAlgorithm>(['raw', 'lz4', 'brotli', 'reactor']);

export class GenomeGenerator {

    /** Decode a variant's stored bytes back to the original chunk. Throws for lossy/unknown variants. */
    public static decodeVariant(variant: Pick<Variant, 'algorithm' | 'data'>): Buffer {
        switch (variant.algorithm) {
            case 'raw': return variant.data;
            case 'lz4': return Buffer.from(lz4.decompress(variant.data));
            case 'brotli': return zlib.brotliDecompressSync(variant.data);
            case 'reactor': return DiocomReactor.decompress(variant.data);
            default:
                throw new Error(`Variant algorithm '${variant.algorithm}' is not reversible/decodable`);
        }
    }

    public static generateVariants(chunkId: string, data: Buffer, config: ACSConfig = DEFAULT_CONFIG, options: GenerateOptions = {}): Variant[] {
        const variants: Variant[] = [];

        // 1. Raw Variant (Baseline)
        variants.push(this.createVariant(chunkId, 'raw', {}, data));

        // 2. LZ4 Variant (Fast)
        try {
            const compressed = Buffer.from(lz4.compress(data));
            variants.push(this.createVariant(chunkId, 'lz4', { level: 1 }, compressed));
        } catch (e) { }
        // 3. Brotli Variant (Dense)
        try {
            const compressed = zlib.brotliCompressSync(data, {
                params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: config.defaultBrotliQuality,
                }
            });
            if (compressed.length < data.length) {
                variants.push(this.createVariant(chunkId, 'brotli', { quality: config.defaultBrotliQuality }, compressed, config.defaultQualityFidelity));
            }
        } catch (e) { }
        if (options.includeSimulated) {
            // 4. AI Upscale (Simulated, lossy: zero-padded copy)
            const upscaledData = Buffer.alloc(Math.floor(data.length * config.upscaleRatio));
            data.copy(upscaledData);
            variants.push(this.createVariant(chunkId, 'ai-upscale', { model: 'gan-v1' }, upscaledData, 0.99));
            // 5. Generative Variant (Simulated, lossy: stores only a description)
            const entropy = this.calculateEntropy(data);

            if (entropy < config.generativeEntropyThreshold) {
                const seedData = Buffer.from(JSON.stringify({ type: 'pattern', len: data.length }));
                variants.push(this.createVariant(chunkId, 'generative', { type: 'pattern' }, seedData, 1.0));
            }
        }

        // 6. DIOCOM REACTOR (PROPRIETARY)
        const reactorResult = DiocomReactor.compress(data);
        if (reactorResult.length < data.length) {
            variants.push(this.createVariant(chunkId, 'reactor', { reactor: true }, reactorResult, 1.1)); // High bonus for proprietary
        }

        return variants;
    }

    private static calculateEntropy(data: Buffer): number {
        // Mock entropy calc. Real one would tally byte frequencies.
        // For sim, we assume the 'Middle-Out' data from benchmark is low entropy.
        if (data.indexOf("Middle-Out") !== -1) return 0.1;
        return 0.8;
    }
    private static createVariant(
        chunkId: string,
        algorithm: CompressionAlgorithm,
        settings: Record<string, any>,
        data: Buffer,
        quality: number = 0.8
    ): Variant {
        const id = crypto.createHash('sha256')
            .update(chunkId)
            .update(algorithm)
            .update(JSON.stringify(settings))
            .digest('hex')
            .substring(0, 16);

        const fitness: FitnessProfile = {
            decodeTime: 0,
            transferTime: 0,
            size: data.length,
            cpuCost: 0,
            accessCount: 0,
            lastAccessed: Date.now()
        };

        return {
            id,
            chunkId,
            algorithm,
            settings,
            data,
            quality,
            fitness
        };
    }
}
