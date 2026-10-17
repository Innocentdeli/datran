/**
 * Orchestration shared by the server runtime (src/lib/prefetcher.ts) and the simulated-trace tests (pure, no I/O):
 * model updates, which predictions to make and how they are scored.
 */

import { PredictionModel, ModelConfig, FilePrediction, SuccessorPrediction } from './model';
import { PredictionMetrics, CacheOutcome } from './metrics';

export interface EngineConfig {
    /** Length of the window predictions are made for. */
    windowMs: number;
    /** Minimum P(access in window) for a file to be predicted. */
    minScore: number;
    /** Max files predicted per tick. */
    maxPredictions: number;
    /** Markov successors warmed per access (k). */
    successorsK: number;
    successorMinWeight: number;
    successorMinProbability: number;
    metricsHorizonMs: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
    windowMs: 3_600_000,
    minScore: 0.2,
    maxPredictions: 50,
    successorsK: 3,
    successorMinWeight: 2,
    successorMinProbability: 0.3,
    metricsHorizonMs: 24 * 3_600_000,
};

export class PredictionEngine {
    readonly cfg: EngineConfig;
    model: PredictionModel;
    readonly metrics: PredictionMetrics;

    constructor(cfg: Partial<EngineConfig> = {}, modelCfg: Partial<ModelConfig> = {}) {
        this.cfg = { ...DEFAULT_ENGINE_CONFIG, ...cfg };
        this.model = new PredictionModel(modelCfg);
        this.metrics = new PredictionMetrics({ horizonMs: this.cfg.metricsHorizonMs });
    }

    /**
     * Serving-side accounting for one counted access, called synchronously when the response is produced (before the
     * model learns from it). Returns whether the request was covered by an open prediction.
     */
    recordServed(fileId: string, ts: number, outcome: CacheOutcome, ttfbMs: number): boolean {
        const predicted = this.metrics.isPredicted(fileId, ts);
        this.metrics.request(ts, predicted, outcome, ttfbMs);
        this.metrics.access(fileId, ts);
        return predicted;
    }

    /** Learns from an access and returns the top-k Markov successors to warm (recorded as sequential predictions). */
    observe(fileId: string, ts: number, actor: string | null): SuccessorPrediction[] {
        this.model.observe(fileId, ts, actor);
        const next = this.model.successors(fileId, ts, this.cfg.successorsK, {
            minWeight: this.cfg.successorMinWeight,
            minProbability: this.cfg.successorMinProbability,
        });
        for (const s of next) this.metrics.predict(s.fileId, 'sequential', ts, this.model.cfg.markovWindowMs);
        return next;
    }

    /** Top predicted files for [now, now + windowMs); each is recorded as a temporal prediction. */
    planTick(now: number): FilePrediction[] {
        this.metrics.advance(now);
        const preds = this.model.predict(now, this.cfg.windowMs, { minScore: this.cfg.minScore, limit: this.cfg.maxPredictions });
        for (const p of preds) this.metrics.predict(p.fileId, 'temporal', now, this.cfg.windowMs);
        return preds;
    }
}
