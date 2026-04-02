import { Chunk, Variant, ClientContext } from '../core/types';
import { FitnessEvaluator } from './FitnessEvaluator';
import { DEFAULT_CONFIG, ACSConfig } from '../core/SystemConfig';

export class EvolutionManager {

    private bandwidthEstimate: number = 500;
    private config: ACSConfig = DEFAULT_CONFIG;

    constructor(config?: ACSConfig) {
        if (config) {
            this.config = config;
            this.bandwidthEstimate = config.defaultBandwidthOps;
        }
    }

    public updateBandwidth(bytesPerMs: number) {
        this.bandwidthEstimate = bytesPerMs;
    }

    public evolve(chunk: Chunk, context: ClientContext = 'server'): void {
        if (chunk.variants.length === 0) return;

        let bestId = chunk.bestVariantId;
        let bestScore = -1;
        const scores = new Map<string, number>();

        // Silent Mode for Stream Sim
        // console.log(`[Evolve] Evaluating ${chunk.variants.length} variants for ${context}...`);

        for (const v of chunk.variants) {
            const score = FitnessEvaluator.calculateScore(v, this.bandwidthEstimate, context, this.config);
            scores.set(v.id, score);

            // console.log(`   - ${v.algorithm} (Q:${v.quality}): ${score.toFixed(0)}`);

            if (score > bestScore) {
                bestScore = score;
                bestId = v.id;
            }
        }

        if (bestId !== chunk.bestVariantId) {
            chunk.bestVariantId = bestId;
        }

        // BIODIVERSITY PRESERVATION: Find Best Quality
        let maxQual = -1;
        let maxQualId = '';
        chunk.variants.forEach(v => {
            const q = v.quality || 0.8;
            if (q > maxQual) {
                maxQual = q;
                maxQualId = v.id;
            }
        });

        // Pruning...
        chunk.variants = chunk.variants.filter(v => {
            if (v.id === bestId) return true;
            if (v.id === maxQualId) return true;

            const score = scores.get(v.id) || 0;
            const relativeFitness = score / bestScore;
            if (v.algorithm === 'raw') return true;
            if (relativeFitness > this.config.biodiversityFloor) return true;
            return false;
        });
    }
}
