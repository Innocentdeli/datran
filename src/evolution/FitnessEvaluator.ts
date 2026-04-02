
import { Variant, FitnessProfile, ClientContext } from '../core/types';
import { ACSConfig, DEFAULT_CONFIG } from '../core/SystemConfig';

export class FitnessEvaluator {
    public static calculateScore(variant: Variant, bandwidthBytesPerMs: number, context: ClientContext = 'server', config: ACSConfig = DEFAULT_CONFIG): number {
        const profile = variant.fitness;

        // 1. Transfer Time
        const transferTime = profile.size / bandwidthBytesPerMs;

        // 2. Decode Time
        let decodePenaltyMultiplier = 1;
        let bandwidthPenaltyMultiplier = 1;

        // CONTEXT AWARENESS LOGIC
        if (context === 'mobile') {
            decodePenaltyMultiplier = config.mobileCpuPenalty;
        } else if (context === 'desktop') {
            decodePenaltyMultiplier = config.desktopCpuPenalty;
        } else if (context === 'vr') {
            decodePenaltyMultiplier = config.vrCpuPenalty;
        } else if (context === 'space') {
            bandwidthPenaltyMultiplier = config.spaceBandwidthPenalty;
        } else if (context === 'cinema') {
            // CINEMA: Quality is King.
            if ((variant.quality || config.defaultQualityFidelity) < config.cinemaQualityThreshold) return 1;

            // If High Quality (0.99), we give it a massive boost to ignore size cost.
            return config.cinemaScoreBoost;
        }

        const decodeTime = (profile.decodeTime || 0.1) * decodePenaltyMultiplier;
        const weightedTransferTime = transferTime * bandwidthPenaltyMultiplier;

        const totalTime = weightedTransferTime + decodeTime;

        if (totalTime === 0) return 1000;

        return (config.baseScoreUnit / totalTime);
    }

    public static recordObservation(variant: Variant, decodeTime: number, config: ACSConfig = DEFAULT_CONFIG) {
        const alpha = config.observationAlpha;
        if (variant.fitness.decodeTime === 0) {
            variant.fitness.decodeTime = decodeTime;
        } else {
            variant.fitness.decodeTime = (variant.fitness.decodeTime * (1 - alpha)) + (decodeTime * alpha);
        }
        variant.fitness.accessCount++;
        variant.fitness.lastAccessed = Date.now();
    }

    /**
     * Calculates the Theoretical Weissman Score.
     * W = alpha * (r / r_bar) * (log(t_bar) / log(t))
     * Where r = compression ratio, t = time
     * Baseline (bar) = Standard Gzip
     */
    public static calculateWeissmanScore(variant: Variant, originalSize: number, context: ClientContext = 'server', config: ACSConfig = DEFAULT_CONFIG): number {
        const ratio = originalSize / variant.fitness.size;
        const time = Math.max(0.1, variant.fitness.decodeTime + variant.fitness.transferTime);

        // BASELINE (Standard Gzip on Middle-out data)
        const RA_BAR = config.gzipRatioBaseline;
        const T_BAR = config.gzipTimeBaselineMs;
        const ALPHA = 1.0;

        let effectiveTime = time;
        let precognitionBoost = 1.0;

        if (time < 1.0) {
            effectiveTime = 1.0;
            precognitionBoost = 1.0 / time;
        }

        const score = ALPHA * (ratio / RA_BAR) * (Math.log10(T_BAR) / Math.log10(effectiveTime)) * precognitionBoost;

        if (context === 'space') return score * config.spaceWeissmanBoost;

        return score;
    }
}
