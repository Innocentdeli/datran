/**
 * Access prediction model (NETWORK_SPEC §5). Pure and incremental: `observe()` is O(168 + successors) per event
 * and all state is bounded (files, successors per file, actors).
 *
 * Three signals, combined as Poisson rates over the prediction window [now, now + W):
 *  1. Recency/frequency — decayed request count → rate ≈ count / effectiveSpan.
 *  2. Temporal — decayed 168-bin hour-of-week histogram → expected accesses in the hours the window covers,
 *     normalized by the number of effective weeks observed.
 *  3. Sequential — first-order Markov transitions A → B per actor (B requested ≤ markovWindowMs after A), decayed;
 *     P(B next | A) = transitions(A→B) / actor-attributed accesses of A.
 *
 * score = P(at least one access in window) = 1 − exp(−(wT·λ_temporal + wR·λ_recency)).
 */

import {
    DecayedCounter, HOUR_MS, HOURS_PER_WEEK, WEEK_MS, DAY_MS,
    bump, counterAt, decayFactor, effectiveSpanMs, effectiveWeeks, hourOfWeek,
} from './decay';

export interface ModelConfig {
    /** Half-life of the recency/frequency counter. */
    recencyHalfLifeMs: number;
    /** Half-life of the hour-of-week histogram (should span several weeks). */
    temporalHalfLifeMs: number;
    /** Half-life of Markov transition counts. */
    markovHalfLifeMs: number;
    /** Max gap between two accesses of one actor for them to count as a transition. */
    markovWindowMs: number;
    maxFiles: number;
    maxSuccessorsPerFile: number;
    maxActors: number;
    weightTemporal: number;
    weightRecency: number;
    /** Pseudo-weeks of a flat (hour-independent) prior mixed into each hour-of-week bin. */
    temporalPriorWeeks: number;
    /** Fixed timezone offset (minutes east of UTC) used for hour-of-week bins. */
    tzOffsetMinutes: number;
}

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
    recencyHalfLifeMs: 2 * DAY_MS,
    temporalHalfLifeMs: 4 * WEEK_MS,
    markovHalfLifeMs: 2 * WEEK_MS,
    markovWindowMs: 30 * 60_000,
    maxFiles: 5000,
    maxSuccessorsPerFile: 20,
    maxActors: 10_000,
    weightTemporal: 1,
    weightRecency: 0.5,
    temporalPriorWeeks: 1,
    tzOffsetMinutes: 0,
};

interface FileState {
    rf: DecayedCounter;
    hist: number[];
    histT: number;
    first: number;
    last: number;
    succ: Map<string, DecayedCounter>;
    /** Decayed count of actor-attributed accesses (Markov half-life): the denominator of P(B next | A). */
    out: DecayedCounter;
}

interface ActorState {
    file: string;
    ts: number;
}

export interface FilePrediction {
    fileId: string;
    /** P(≥1 access in the window) in [0, 1). */
    score: number;
    lambdaTemporal: number;
    lambdaRecency: number;
}

export interface SuccessorPrediction {
    fileId: string;
    /**
     * Estimated P(the same actor requests this file within markovWindowMs | it requested the source file):
     * decayed transitions A→B / decayed actor-attributed accesses of A (capped at 1).
     */
    probability: number;
    /** Decayed transition count. */
    weight: number;
}

export class PredictionModel {
    readonly cfg: ModelConfig;
    private files = new Map<string, FileState>();
    private actors = new Map<string, ActorState>();
    private eventCount = 0;

    constructor(cfg: Partial<ModelConfig> = {}) {
        this.cfg = { ...DEFAULT_MODEL_CONFIG, ...cfg };
    }

    get trackedFiles(): number { return this.files.size; }
    get trackedActors(): number { return this.actors.size; }
    get observedEvents(): number { return this.eventCount; }

    observe(fileId: string, ts: number, actor: string | null): void {
        this.eventCount++;
        let f = this.files.get(fileId);
        if (!f) {
            f = { rf: { v: 0, t: ts }, hist: new Array(HOURS_PER_WEEK).fill(0), histT: ts, first: ts, last: ts, succ: new Map(), out: { v: 0, t: ts } };
            this.files.set(fileId, f);
            if (this.files.size > Math.ceil(this.cfg.maxFiles * 1.1)) this.prune(ts);
        }
        bump(f.rf, ts, this.cfg.recencyHalfLifeMs);

        const bin = hourOfWeek(ts, this.cfg.tzOffsetMinutes);
        if (ts >= f.histT) {
            const k = decayFactor(ts - f.histT, this.cfg.temporalHalfLifeMs);
            if (k !== 1) for (let i = 0; i < HOURS_PER_WEEK; i++) f.hist[i] *= k;
            f.histT = ts;
            f.hist[bin] += 1;
        } else {
            f.hist[bin] += decayFactor(f.histT - ts, this.cfg.temporalHalfLifeMs);
        }
        if (ts < f.first) f.first = ts;
        if (ts > f.last) f.last = ts;

        if (actor) {
            const prev = this.actors.get(actor);
            // An immediate re-request of the same file (reload, player restart) is not a new chance to move on.
            const repeat = !!prev && prev.file === fileId && ts >= prev.ts && ts - prev.ts <= this.cfg.markovWindowMs;
            if (!repeat) bump(f.out, ts, this.cfg.markovHalfLifeMs);
            if (prev && prev.file !== fileId && ts >= prev.ts && ts - prev.ts <= this.cfg.markovWindowMs) {
                const src = this.files.get(prev.file);
                if (src) this.addTransition(src, fileId, ts);
            }
            if (!prev || ts >= prev.ts) {
                this.actors.delete(actor); // refresh LRU position
                this.actors.set(actor, { file: fileId, ts });
                if (this.actors.size > this.cfg.maxActors) {
                    const oldest = this.actors.keys().next().value as string;
                    this.actors.delete(oldest);
                }
            }
        }
    }

    private addTransition(src: FileState, to: string, ts: number) {
        let c = src.succ.get(to);
        if (!c) {
            c = { v: 0, t: ts };
            src.succ.set(to, c);
        }
        bump(c, ts, this.cfg.markovHalfLifeMs);
        if (src.succ.size > this.cfg.maxSuccessorsPerFile) {
            let minKey: string | null = null;
            let minV = Infinity;
            for (const [k, sc] of src.succ) {
                if (k === to) continue;
                const v = counterAt(sc, ts, this.cfg.markovHalfLifeMs);
                if (v < minV) { minV = v; minKey = k; }
            }
            if (minKey) src.succ.delete(minKey);
        }
    }

    /** Drops the coldest files (by recency counter) down to maxFiles. */
    private prune(now: number) {
        const ranked = [...this.files.entries()]
            .map(([id, f]) => ({ id, v: counterAt(f.rf, now, this.cfg.recencyHalfLifeMs) + this.temporalMass(f, now) / 168 }))
            .sort((a, b) => a.v - b.v);
        const excess = this.files.size - this.cfg.maxFiles;
        for (let i = 0; i < excess; i++) this.files.delete(ranked[i].id);
    }

    private temporalMass(f: FileState, now: number): number {
        const k = decayFactor(now - f.histT, this.cfg.temporalHalfLifeMs);
        let s = 0;
        for (let i = 0; i < HOURS_PER_WEEK; i++) s += f.hist[i];
        return s * k;
    }

    /** Removes a file (deleted/expired) from the model, including as a successor. */
    forget(fileId: string): void {
        this.files.delete(fileId);
        for (const f of this.files.values()) f.succ.delete(fileId);
    }

    has(fileId: string): boolean { return this.files.has(fileId); }

    /** Expected accesses of `fileId` in [now, now + windowMs) from the hour-of-week histogram. */
    temporalLambda(fileId: string, now: number, windowMs: number): number {
        const f = this.files.get(fileId);
        return f ? this.temporalLambdaOf(f, now, windowMs) : 0;
    }

    private temporalLambdaOf(f: FileState, now: number, windowMs: number): number {
        if (windowMs <= 0) return 0;
        const k = decayFactor(now - f.histT, this.cfg.temporalHalfLifeMs);
        const weeks = effectiveWeeks(now - f.first, this.cfg.temporalHalfLifeMs);
        const tz = this.cfg.tzOffsetMinutes * 60_000;
        const end = now + windowMs;
        let cursor = now;
        let lambda = 0;
        // Windows longer than a week wrap; cap iterations at 169 hours of distinct coverage.
        for (let guard = 0; cursor < end && guard < 400; guard++) {
            const intoHour = (((cursor + tz) % HOUR_MS) + HOUR_MS) % HOUR_MS;
            const hourEnd = Math.min(cursor + (HOUR_MS - intoHour), end);
            lambda += f.hist[hourOfWeek(cursor, this.cfg.tzOffsetMinutes)] * ((hourEnd - cursor) / HOUR_MS);
            cursor = hourEnd;
        }
        // Shrink each bin toward the file's flat hourly mean with `temporalPriorWeeks` pseudo-weeks of evidence:
        // damps Poisson noise in sparsely observed bins without hiding strong weekly structure.
        const alpha = Math.max(0, this.cfg.temporalPriorWeeks);
        let total = 0;
        if (alpha > 0) for (let i = 0; i < HOURS_PER_WEEK; i++) total += f.hist[i];
        const prior = alpha * (total / HOURS_PER_WEEK) * (windowMs / HOUR_MS);
        return ((lambda + prior) * k) / (weeks + alpha);
    }

    /** Expected accesses in the window from the decayed request rate. */
    recencyLambda(fileId: string, now: number, windowMs: number): number {
        const f = this.files.get(fileId);
        return f ? this.recencyLambdaOf(f, now, windowMs) : 0;
    }

    private recencyLambdaOf(f: FileState, now: number, windowMs: number): number {
        const v = counterAt(f.rf, now, this.cfg.recencyHalfLifeMs);
        // Floor the observation span at max(window, 1 h) so a single fresh hit doesn't imply an absurd rate.
        const eff = effectiveSpanMs(Math.max(now - f.first, windowMs, HOUR_MS), this.cfg.recencyHalfLifeMs);
        return (v / eff) * windowMs;
    }

    scoreFile(fileId: string, now: number, windowMs: number): FilePrediction | null {
        const f = this.files.get(fileId);
        if (!f) return null;
        return this.scoreOf(fileId, f, now, windowMs);
    }

    private scoreOf(fileId: string, f: FileState, now: number, windowMs: number): FilePrediction {
        const lt = this.temporalLambdaOf(f, now, windowMs);
        const lr = this.recencyLambdaOf(f, now, windowMs);
        // Both signals estimate the same rate; mix them (weighted mean) rather than add, so a file with flat
        // traffic isn't double counted. Temporal structure then lifts/lowers the estimate hour by hour.
        const wSum = this.cfg.weightTemporal + this.cfg.weightRecency;
        const lambda = wSum > 0 ? (this.cfg.weightTemporal * lt + this.cfg.weightRecency * lr) / wSum : 0;
        return { fileId, score: 1 - Math.exp(-lambda), lambdaTemporal: lt, lambdaRecency: lr };
    }

    /** Files ranked by score for the window [now, now + windowMs). */
    predict(now: number, windowMs: number, opts: { limit?: number; minScore?: number } = {}): FilePrediction[] {
        const minScore = opts.minScore ?? 0;
        const out: FilePrediction[] = [];
        for (const [id, f] of this.files) {
            const p = this.scoreOf(id, f, now, windowMs);
            if (p.score > 0 && p.score >= minScore) out.push(p);
        }
        out.sort((a, b) => b.score - a.score || a.fileId.localeCompare(b.fileId));
        return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
    }

    /** Top-k Markov successors of `fileId` at `now`. */
    successors(fileId: string, now: number, k: number, opts: { minWeight?: number; minProbability?: number } = {}): SuccessorPrediction[] {
        const f = this.files.get(fileId);
        if (!f || f.succ.size === 0 || k <= 0) return [];
        const minWeight = opts.minWeight ?? 0;
        const minP = opts.minProbability ?? 0;
        const out = counterAt(f.out, now, this.cfg.markovHalfLifeMs);
        if (out <= 0) return [];
        const rows: SuccessorPrediction[] = [];
        for (const [id, c] of f.succ) {
            const w = counterAt(c, now, this.cfg.markovHalfLifeMs);
            rows.push({ fileId: id, probability: Math.min(1, w / out), weight: w });
        }
        return rows
            .filter((r) => r.weight >= minWeight && r.probability >= minP)
            .sort((a, b) => b.weight - a.weight || a.fileId.localeCompare(b.fileId))
            .slice(0, k);
    }
}
