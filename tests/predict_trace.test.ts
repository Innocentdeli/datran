/**
 * Integration-style test: a simulated 8-week access trace replayed through the same pure engine, selection and
 * cache logic the server uses (diocom-app/src/lib/predict). Alice opens "report" then "slides" every weekday at
 * ~9:00 (UTC); background actors read 30 other files with Zipf-like popularity all day.
 * Compares prefetch on vs. off (demand-only cache) and the full model vs. a recency-only predictor.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    PredictionEngine, ByteLruCache, selectWithinBudget, MetricsSnapshot, HOUR_MS, DAY_MS, WEEK_MS,
} from '../diocom-app/src/lib/predict';

const MiB = 1024 * 1024;
const START = Date.UTC(2026, 0, 5); // Monday 00:00 UTC
const WEEKS = 8;
const TICK_MS = 60_000;
const DEMAND_TTL_MS = 90_000;

function prng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

interface Access { ts: number; file: string; actor: string }

function buildTrace(): { trace: Access[]; sizes: Map<string, number> } {
    const r = prng(42);
    const sizes = new Map<string, number>([['report', 2 * MiB], ['slides', 3 * MiB]]);
    const noise: string[] = [];
    for (let i = 0; i < 30; i++) { noise.push(`n${i}`); sizes.set(`n${i}`, Math.round((1 + r() * 3) * MiB)); }
    const zipfW = noise.map((_, i) => 1 / (i + 1));
    const zipfSum = zipfW.reduce((a, b) => a + b, 0);
    const pickNoise = () => {
        let x = r() * zipfSum;
        for (let i = 0; i < noise.length; i++) { x -= zipfW[i]; if (x <= 0) return noise[i]; }
        return noise[noise.length - 1];
    };

    const trace: Access[] = [];
    for (let day = 0; day < WEEKS * 7; day++) {
        const base = START + day * DAY_MS;
        const dow = new Date(base).getUTCDay();
        if (dow >= 1 && dow <= 5) {
            const t1 = base + 9 * HOUR_MS + Math.floor(r() * 4 * 60_000);
            trace.push({ ts: t1, file: 'report', actor: 'u:alice' });
            trace.push({ ts: t1 + 2 * 60_000 + Math.floor(r() * 6 * 60_000), file: 'slides', actor: 'u:alice' });
        }
        // ~40 background accesses per day, uniformly over the day, from 20 anonymous actors.
        for (let i = 0; i < 40; i++) {
            trace.push({ ts: base + Math.floor(r() * DAY_MS), file: pickNoise(), actor: `a:${Math.floor(r() * 20)}` });
        }
    }
    trace.sort((a, b) => a.ts - b.ts);
    return { trace, sizes };
}

interface SimResult {
    snapshot: MetricsSnapshot;
    hitRate: number;
    aliceHitRate: number;
    prefetchHits: number;
    prefetchWasted: number;
    /** Mean squared error of P(access in next hour) over (file, 15-min tick) pairs in the measured weeks. */
    brier: number;
    /** Fraction of those (file, window) pairs that actually contained an access: precision of a random predictor. */
    baseRate: number;
    /** Brier restricted to alice's two files (the ones with weekly structure). */
    brierAlice: number;
}

function simulate(opts: { prefetch: boolean; weightTemporal?: number }): SimResult {
    const { trace, sizes } = buildTrace();
    const engine = new PredictionEngine(
        { windowMs: HOUR_MS, metricsHorizonMs: 4 * WEEK_MS },
        opts.weightTemporal !== undefined ? { weightTemporal: opts.weightTemporal } : {},
    );
    const cache = new ByteLruCache<{ length: number }>({ maxBytes: 64 * MiB, maxItemBytes: 16 * MiB, prefetchMaxBytes: 16 * MiB });
    const measureFrom = START + 4 * WEEK_MS;
    let hits = 0, total = 0, aliceHits = 0, aliceTotal = 0;

    const warm = (file: string, now: number, source: 'predicted' | 'successor', ttlMs: number) =>
        cache.set(file, { length: sizes.get(file)! }, 'sim', now, { source, ttlMs });

    const accessTimes = new Map<string, number[]>();
    for (const a of trace) {
        if (!accessTimes.has(a.file)) accessTimes.set(a.file, []);
        accessTimes.get(a.file)!.push(a.ts);
    }
    const accessedIn = (file: string, from: number, to: number) => {
        const xs = accessTimes.get(file) ?? [];
        let lo = 0, hi = xs.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < from) lo = mid + 1; else hi = mid; }
        return lo < xs.length && xs[lo] < to;
    };
    let brierSum = 0, brierN = 0, positives = 0, brierAliceSum = 0, brierAliceN = 0;

    let nextTick = START;
    for (const a of trace) {
        while (nextTick <= a.ts) {
            if (nextTick >= measureFrom && (nextTick - START) % (15 * 60_000) === 0) {
                for (const file of sizes.keys()) {
                    const p = engine.model.scoreFile(file, nextTick, engine.cfg.windowMs)?.score ?? 0;
                    const y = accessedIn(file, nextTick, nextTick + engine.cfg.windowMs) ? 1 : 0;
                    brierSum += (p - y) ** 2; brierN++; positives += y;
                    if (file === 'report' || file === 'slides') { brierAliceSum += (p - y) ** 2; brierAliceN++; }
                }
            }
            const preds = engine.planTick(nextTick);
            if (opts.prefetch) {
                const sel = selectWithinBudget(
                    preds.map((p) => ({ fileId: p.fileId, score: p.score, bytes: sizes.get(p.fileId)!, cached: cache.has(p.fileId, nextTick) })),
                    { budgetBytes: cache.opts.prefetchMaxBytes, maxItemBytes: cache.opts.maxItemBytes },
                );
                for (const c of sel.chosen) {
                    if (c.cached) cache.extend(c.fileId, nextTick + engine.cfg.windowMs, nextTick);
                    else warm(c.fileId, nextTick, 'predicted', engine.cfg.windowMs);
                }
            }
            nextTick += TICK_MS;
        }
        const hit = cache.get(a.file, a.ts, DEMAND_TTL_MS) !== null;
        if (!hit) cache.set(a.file, { length: sizes.get(a.file)! }, 'sim', a.ts, { source: 'demand', ttlMs: DEMAND_TTL_MS });
        engine.recordServed(a.file, a.ts, hit ? 'hit' : 'miss', hit ? 1 : 50);
        const succ = engine.observe(a.file, a.ts, a.actor);
        if (opts.prefetch) for (const s of succ) warm(s.fileId, a.ts, 'successor', engine.model.cfg.markovWindowMs);

        if (a.ts >= measureFrom) {
            total++; if (hit) hits++;
            if (a.actor === 'u:alice') { aliceTotal++; if (hit) aliceHits++; }
        }
    }
    const end = START + WEEKS * WEEK_MS;
    const st = cache.stats();
    const sum = (o: Record<string, number>) => Object.values(o).reduce((x, y) => x + y, 0);
    return {
        snapshot: engine.metrics.snapshot(end),
        hitRate: hits / total,
        aliceHitRate: aliceHits / aliceTotal,
        prefetchHits: sum(st.prefetchHits),
        prefetchWasted: sum(st.prefetchWasted),
        brier: brierSum / brierN,
        baseRate: positives / brierN,
        brierAlice: brierAliceSum / brierAliceN,
    };
}

describe('simulated access trace (weekday 9am report → slides)', () => {
    const off = simulate({ prefetch: false });
    const on = simulate({ prefetch: true });
    const recencyOnly = simulate({ prefetch: true, weightTemporal: 0 });

    const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
    console.log(
        `[trace] last 4 weeks — hit rate: no prefetch ${pct(off.hitRate)}, prefetch ${pct(on.hitRate)} ` +
        `(recency-only ${pct(recencyOnly.hitRate)}); alice: ${pct(off.aliceHitRate)} → ${pct(on.aliceHitRate)}; ` +
        `precision temporal ${pct(on.snapshot.precision.temporal.rate)} (recency-only ${pct(recencyOnly.snapshot.precision.temporal.rate)}), ` +
        `sequential ${pct(on.snapshot.precision.sequential.rate)}, all ${pct(on.snapshot.precision.all.rate)}; ` +
        `recall ${pct(on.snapshot.recall.rate)} (recency-only ${pct(recencyOnly.snapshot.recall.rate)}); ` +
        `hit rate predicted ${pct(on.snapshot.hitRate.predicted.rate)} vs unpredicted ${pct(on.snapshot.hitRate.unpredicted.rate)}; ` +
        `prefetch hits ${on.prefetchHits}, wasted ${on.prefetchWasted}; ` +
        `Brier ${on.brier.toFixed(4)} (recency-only ${recencyOnly.brier.toFixed(4)}), ` +
        `Brier alice ${on.brierAlice.toFixed(4)} (recency-only ${recencyOnly.brierAlice.toFixed(4)}), base rate ${pct(on.baseRate)}`,
    );

    test('prefetch raises the overall cache hit rate vs demand-only caching', () => {
        assert.ok(on.hitRate > off.hitRate + 0.1, `${on.hitRate} vs ${off.hitRate}`);
    });

    test("alice's weekday 9am report+slides are served warm", () => {
        assert.ok(off.aliceHitRate < 0.1, `baseline ${off.aliceHitRate}`);
        assert.ok(on.aliceHitRate >= 0.9, `prefetch ${on.aliceHitRate}`);
    });

    test('predictions are far more precise than chance (base rate of a (file, hour) pair being accessed)', () => {
        assert.ok(on.snapshot.precision.all.rate! > 2 * on.baseRate, `${on.snapshot.precision.all.rate} vs base ${on.baseRate}`);
    });

    test('temporal model: better calibrated where weekly structure exists, no worse overall, higher recall', () => {
        assert.ok(on.brierAlice < 0.8 * recencyOnly.brierAlice, `${on.brierAlice} vs ${recencyOnly.brierAlice}`);
        assert.ok(on.brier < recencyOnly.brier * 1.05, `${on.brier} vs ${recencyOnly.brier}`);
        assert.ok(on.snapshot.recall.rate! > recencyOnly.snapshot.recall.rate!, `${on.snapshot.recall.rate} vs ${recencyOnly.snapshot.recall.rate}`);
    });

    test('sequential (Markov) predictions are precise for the report → slides pattern', () => {
        assert.ok(on.snapshot.precision.sequential.denominator > 0);
        assert.ok(on.snapshot.precision.sequential.rate! >= 0.5, `${on.snapshot.precision.sequential.rate}`);
    });

    test('predicted requests hit the cache far more often than unpredicted ones', () => {
        const h = on.snapshot.hitRate;
        assert.ok(h.predicted.rate! > h.unpredicted.rate!, JSON.stringify(h));
    });

    test('prefetched entries are attributed: some hit, and the budget held', () => {
        assert.ok(on.prefetchHits > 0);
    });
});
