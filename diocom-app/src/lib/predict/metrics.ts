/**
 * Honest, measured prediction metrics over a rolling horizon (pure).
 *
 * - A prediction (file, kind, [start, end)) "hits" if that file is accessed within its window. A file with an open
 *   prediction of the same kind is not re-predicted until that window closes, so a file that stays predicted yields
 *   one prediction per window, not one per tick.
 * - Precision = hits / predictions, over predictions whose window has CLOSED within the horizon (open windows are
 *   not counted yet — they could still hit).
 * - Recall = accesses that were covered by an open prediction at access time / all accesses in the horizon.
 * - Cache hit rate is split by whether the request was predicted; only cacheable requests (hit|miss) count.
 * - TTFB (server-side, ms) percentiles for cache hits vs misses (and disk-streamed requests for reference).
 */

import { percentile } from './decay';

export type PredictionKind = 'temporal' | 'sequential' | 'intent';
export type CacheOutcome = 'hit' | 'miss' | 'disk';

interface OpenPrediction {
    kind: PredictionKind;
    start: number;
    end: number;
    hit: boolean;
}

interface ClosedPrediction {
    kind: PredictionKind;
    end: number;
    hit: boolean;
}

interface RequestSample {
    ts: number;
    predicted: boolean;
    outcome: CacheOutcome;
    ttfbMs: number;
}

export interface RateSummary {
    numerator: number;
    denominator: number;
    rate: number | null;
}

export interface MetricsSnapshot {
    horizonMs: number;
    precision: Record<PredictionKind | 'all', RateSummary>;
    recall: RateSummary;
    openPredictions: number;
    hitRate: { predicted: RateSummary; unpredicted: RateSummary; all: RateSummary };
    ttfbMs: Record<CacheOutcome, { count: number; p50: number | null; p95: number | null }>;
    requests: number;
}

const rate = (n: number, d: number): RateSummary => ({ numerator: n, denominator: d, rate: d > 0 ? n / d : null });

export class PredictionMetrics {
    readonly horizonMs: number;
    private readonly maxClosed: number;
    private readonly maxSamples: number;
    private open = new Map<string, OpenPrediction[]>();
    private openCount = 0;
    private closed: ClosedPrediction[] = [];
    private accesses: { ts: number; predicted: boolean }[] = [];
    private requests: RequestSample[] = [];

    constructor(opts: { horizonMs?: number; maxClosed?: number; maxSamples?: number } = {}) {
        this.horizonMs = opts.horizonMs ?? 24 * 3_600_000;
        this.maxClosed = opts.maxClosed ?? 100_000;
        this.maxSamples = opts.maxSamples ?? 50_000;
    }

    /** Moves predictions whose window ended before `now` to the closed list and drops data older than the horizon. */
    advance(now: number) {
        for (const [fileId, list] of this.open) {
            const keep: OpenPrediction[] = [];
            for (const p of list) {
                if (p.end <= now) {
                    this.closed.push({ kind: p.kind, end: p.end, hit: p.hit });
                    this.openCount--;
                } else keep.push(p);
            }
            if (keep.length) this.open.set(fileId, keep);
            else this.open.delete(fileId);
        }
        const cutoff = now - this.horizonMs;
        this.closed = trim(this.closed.filter((p) => p.end > cutoff), this.maxClosed);
        this.accesses = trim(this.accesses.filter((a) => a.ts > cutoff), this.maxSamples);
        this.requests = trim(this.requests.filter((r) => r.ts > cutoff), this.maxSamples);
    }

    /** Records a prediction unless one of the same kind is already open for this file. Returns true if recorded. */
    predict(fileId: string, kind: PredictionKind, now: number, windowMs: number): boolean {
        const list = this.open.get(fileId) ?? [];
        if (list.some((p) => p.kind === kind && p.end > now)) return false;
        if (this.openCount >= this.maxClosed) return false; // hard memory bound
        list.push({ kind, start: now, end: now + windowMs, hit: false });
        this.open.set(fileId, list);
        this.openCount++;
        return true;
    }

    /** True if an open prediction (any kind) covers `fileId` at `ts`. */
    isPredicted(fileId: string, ts: number): boolean {
        const list = this.open.get(fileId);
        return !!list && list.some((p) => p.start <= ts && ts < p.end);
    }

    /** Records an access: marks covering predictions as hits and counts it for recall. */
    access(fileId: string, ts: number): boolean {
        const list = this.open.get(fileId);
        let covered = false;
        if (list) {
            for (const p of list) {
                if (p.start <= ts && ts < p.end) {
                    p.hit = true;
                    covered = true;
                }
            }
        }
        this.accesses.push({ ts, predicted: covered });
        if (this.accesses.length > this.maxSamples * 2) this.accesses = trim(this.accesses, this.maxSamples);
        return covered;
    }

    request(ts: number, predicted: boolean, outcome: CacheOutcome, ttfbMs: number) {
        this.requests.push({ ts, predicted, outcome, ttfbMs });
        if (this.requests.length > this.maxSamples * 2) this.requests = trim(this.requests, this.maxSamples);
    }

    snapshot(now: number): MetricsSnapshot {
        this.advance(now);
        const kinds: PredictionKind[] = ['temporal', 'sequential', 'intent'];
        const precision = {} as MetricsSnapshot['precision'];
        let allHits = 0;
        for (const k of kinds) {
            const ps = this.closed.filter((p) => p.kind === k);
            const hits = ps.filter((p) => p.hit).length;
            allHits += hits;
            precision[k] = rate(hits, ps.length);
        }
        precision.all = rate(allHits, this.closed.length);

        const cacheable = this.requests.filter((r) => r.outcome !== 'disk');
        const pred = cacheable.filter((r) => r.predicted);
        const unpred = cacheable.filter((r) => !r.predicted);
        const hits = (xs: RequestSample[]) => xs.filter((r) => r.outcome === 'hit').length;

        const ttfb = {} as MetricsSnapshot['ttfbMs'];
        for (const o of ['hit', 'miss', 'disk'] as CacheOutcome[]) {
            const v = this.requests.filter((r) => r.outcome === o).map((r) => r.ttfbMs);
            ttfb[o] = { count: v.length, p50: percentile(v, 50), p95: percentile(v, 95) };
        }

        return {
            horizonMs: this.horizonMs,
            precision,
            recall: rate(this.accesses.filter((a) => a.predicted).length, this.accesses.length),
            openPredictions: this.openCount,
            hitRate: {
                predicted: rate(hits(pred), pred.length),
                unpredicted: rate(hits(unpred), unpred.length),
                all: rate(hits(cacheable), cacheable.length),
            },
            ttfbMs: ttfb,
            requests: this.requests.length,
        };
    }
}

function trim<T>(xs: T[], max: number): T[] {
    return xs.length > max ? xs.slice(xs.length - max) : xs;
}
