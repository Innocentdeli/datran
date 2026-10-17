/**
 * Unit tests for the access prediction math, prefetch selection under budget, the tagged byte cache and the
 * metrics (diocom-app/src/lib/predict — pure modules, NETWORK_SPEC §5).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    decayFactor, bump, counterAt, effectiveWeeks, effectiveSpanMs, hourOfWeek, percentile,
    HOUR_MS, DAY_MS, WEEK_MS,
    PredictionModel, selectWithinBudget, ByteLruCache, PredictionMetrics, PredictionEngine,
} from '../diocom-app/src/lib/predict';

const MON = Date.UTC(2026, 0, 5); // Monday 00:00 UTC
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const buf = (n: number) => ({ length: n });

describe('decay primitives', () => {
    test('decayFactor halves every half-life and never decays for dt <= 0', () => {
        close(decayFactor(HOUR_MS, HOUR_MS), 0.5);
        close(decayFactor(3 * HOUR_MS, HOUR_MS), 0.125);
        assert.equal(decayFactor(0, HOUR_MS), 1);
        assert.equal(decayFactor(-5, HOUR_MS), 1);
        assert.equal(decayFactor(HOUR_MS, 0), 1);
    });

    test('bump/counterAt accumulate decayed counts; out-of-order events decay forward', () => {
        const c = { v: 0, t: 0 };
        bump(c, 0, 10);
        bump(c, 10, 10); // 1 * 0.5 + 1
        close(c.v, 1.5);
        close(counterAt(c, 20, 10), 0.75);
        bump(c, 0, 10); // late event from t=0, worth 0.5 at t=10
        close(c.v, 2);
        assert.equal(c.t, 10);
        assert.equal(counterAt(undefined, 5, 10), 0);
    });

    test('effectiveWeeks is 1 for a week of data and converges to the geometric limit', () => {
        close(effectiveWeeks(WEEK_MS, 4 * WEEK_MS), 1);
        close(effectiveWeeks(0, 4 * WEEK_MS), 1); // floored at one week
        close(effectiveWeeks(1000 * WEEK_MS, 4 * WEEK_MS), 1 / (1 - Math.pow(2, -0.25)), 1e-6);
        close(effectiveSpanMs(1e15, HOUR_MS), HOUR_MS / Math.LN2, 1e-3);
    });

    test('hourOfWeek: Sunday 00:00 = 0, Monday 09:30 = 33, timezone offset shifts bins', () => {
        assert.equal(hourOfWeek(Date.UTC(2026, 0, 4)), 0);
        assert.equal(hourOfWeek(MON + 9.5 * HOUR_MS), 33);
        assert.equal(hourOfWeek(Date.UTC(2026, 0, 10, 23, 59)), 167);
        assert.equal(hourOfWeek(MON + 9 * HOUR_MS, 120), 35); // UTC+2: 11:00 local
        assert.equal(hourOfWeek(MON, -60), 23); // Sunday 23:00 local
    });

    test('percentile interpolates and handles empty input', () => {
        assert.equal(percentile([], 50), null);
        assert.equal(percentile([5], 95), 5);
        assert.equal(percentile([1, 2, 3, 4], 50), 2.5);
        close(percentile([10, 1, 2, 3, 4, 5, 6, 7, 8, 9], 95)!, 9.55);
    });
});

describe('prediction model', () => {
    test('temporal: weekly Monday 9am pattern gives exact rate with no decay/prior, and zero elsewhere', () => {
        const m = new PredictionModel({ temporalHalfLifeMs: 1e15, temporalPriorWeeks: 0 });
        for (let w = 0; w < 4; w++) m.observe('report', MON + w * WEEK_MS + 9 * HOUR_MS + 60_000, null);
        const now = MON + 4 * WEEK_MS + 9 * HOUR_MS + 60_000; // span = 4 weeks → 4 effective weeks
        close(m.temporalLambda('report', now - 60_000, HOUR_MS), 1, 1e-3); // the whole Monday 9:00 bin
        close(m.temporalLambda('report', now - 30 * 60_000 - 60_000, HOUR_MS), 0.5, 1e-3); // 8:30–9:30
        close(m.temporalLambda('report', now + DAY_MS, HOUR_MS), 0, 1e-12); // Tuesday 9am
        assert.equal(m.temporalLambda('nope', now, HOUR_MS), 0);
    });

    test('temporal: score is higher just before the habitual hour than at other times', () => {
        const m = new PredictionModel();
        for (let w = 0; w < 6; w++) {
            for (let d = 0; d < 5; d++) m.observe('report', MON + w * WEEK_MS + d * DAY_MS + 9 * HOUR_MS, null);
        }
        const base = MON + 6 * WEEK_MS;
        const before = m.scoreFile('report', base + 8.5 * HOUR_MS, HOUR_MS)!.score;
        const evening = m.scoreFile('report', base + 20 * HOUR_MS, HOUR_MS)!.score;
        const sunday = m.scoreFile('report', base - 15 * HOUR_MS, HOUR_MS)!.score;
        assert.ok(before > 0.2, `before=${before}`);
        assert.ok(before > 3 * evening, `${before} vs ${evening}`);
        assert.ok(before > 3 * sunday, `${before} vs ${sunday}`);
    });

    test('recency/frequency: hot files outrank cold ones and decay over time', () => {
        const m = new PredictionModel({ weightTemporal: 0 });
        const t = MON;
        for (let i = 0; i < 20; i++) m.observe('hot', t + i * 60_000, null);
        m.observe('cold', t, null);
        const now = t + 30 * 60_000;
        const hot = m.scoreFile('hot', now, HOUR_MS)!.score;
        const cold = m.scoreFile('cold', now, HOUR_MS)!.score;
        assert.ok(hot > cold, `${hot} vs ${cold}`);
        const later = m.scoreFile('hot', now + 10 * DAY_MS, HOUR_MS)!.score;
        assert.ok(later < hot / 10, `${later} vs ${hot}`);
        assert.deepEqual(m.predict(now, HOUR_MS, { limit: 1 }).map((p) => p.fileId), ['hot']);
    });

    test('Markov: per-actor transitions within 30 min only, no self-transitions, P ≈ 1 for a fixed sequence', () => {
        const m = new PredictionModel();
        for (let d = 0; d < 5; d++) {
            const t = MON + d * DAY_MS;
            m.observe('report', t, 'u:alice');
            m.observe('report', t + 60_000, 'u:alice'); // repeat: no self-transition
            m.observe('slides', t + 5 * 60_000, 'u:alice');
            m.observe('other', t + 5 * 60_000, 'u:bob'); // different actor: not a successor of report
            m.observe('late', t + 50 * 60_000, 'u:alice'); // 45 min after slides: outside the window
        }
        const now = MON + 5 * DAY_MS;
        const s = m.successors('report', now, 3);
        assert.deepEqual(s.map((x) => x.fileId), ['slides']);
        assert.ok(s[0].probability > 0.95 && s[0].probability <= 1, `${s[0].probability}`);
        assert.equal(m.successors('slides', now, 3).length, 0);
        assert.equal(m.successors('report', now, 3, { minWeight: 100 }).length, 0);
        // Anonymous (null actor) accesses never create transitions.
        const m2 = new PredictionModel();
        m2.observe('a', MON, null);
        m2.observe('b', MON + 1000, null);
        assert.equal(m2.successors('a', MON + 2000, 3).length, 0);
    });

    test('Markov: transitions decay; top-k ranks by decayed weight', () => {
        const m = new PredictionModel({ markovHalfLifeMs: DAY_MS });
        for (let i = 0; i < 4; i++) { m.observe('a', MON + i * HOUR_MS, 'x'); m.observe('old', MON + i * HOUR_MS + 1000, 'x'); }
        const t2 = MON + 5 * DAY_MS;
        for (let i = 0; i < 2; i++) { m.observe('a', t2 + i * HOUR_MS, 'x'); m.observe('new', t2 + i * HOUR_MS + 1000, 'x'); }
        const s = m.successors('a', t2 + 2 * HOUR_MS, 2);
        assert.deepEqual(s.map((x) => x.fileId), ['new', 'old']);
        assert.ok(s[1].weight < 0.2, `${s[1].weight}`);
    });

    test('state is bounded: successors per file, files and actors are capped', () => {
        const m = new PredictionModel({ maxSuccessorsPerFile: 3, maxFiles: 10, maxActors: 5 });
        // 'src' → s0..s5, with s5 most frequent
        for (let i = 0; i < 6; i++) {
            for (let r = 0; r <= i; r++) {
                const t = MON + (i * 10 + r) * HOUR_MS;
                m.observe('src', t, 'act');
                m.observe(`s${i}`, t + 1000, 'act');
            }
        }
        const s = m.successors('src', MON + 100 * HOUR_MS, 10);
        assert.ok(s.length <= 3);
        assert.equal(s[0].fileId, 's5');
        for (let i = 0; i < 50; i++) m.observe(`f${i}`, MON + 200 * HOUR_MS + i, `actor${i}`);
        assert.ok(m.trackedFiles <= 11, `${m.trackedFiles}`);
        assert.ok(m.trackedActors <= 5, `${m.trackedActors}`);
    });

    test('forget removes a file and its successor references', () => {
        const m = new PredictionModel();
        m.observe('a', MON, 'x');
        m.observe('b', MON + 1000, 'x');
        m.observe('a', MON + 2000, 'x');
        m.observe('b', MON + 3000, 'x');
        assert.equal(m.successors('a', MON + 4000, 3)[0].fileId, 'b');
        m.forget('b');
        assert.equal(m.has('b'), false);
        assert.equal(m.successors('a', MON + 4000, 3).length, 0);
    });
});

describe('prefetch selection under budget', () => {
    test('greedy by score; skips items that do not fit but takes smaller lower-ranked ones', () => {
        const sel = selectWithinBudget([
            { fileId: 'a', score: 0.9, bytes: 60 },
            { fileId: 'b', score: 0.8, bytes: 50 }, // doesn't fit after a
            { fileId: 'c', score: 0.5, bytes: 40 },
            { fileId: 'd', score: 0.4, bytes: 10 }, // doesn't fit after a + c
        ], { budgetBytes: 100 });
        assert.deepEqual(sel.chosen.map((c) => c.fileId), ['a', 'c']);
        assert.equal(sel.usedBytes, 100);
        assert.equal(sel.skippedOverBudget, 2);
    });

    test('never exceeds the budget for random candidate sets', () => {
        let s = 7;
        const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
        for (let trial = 0; trial < 200; trial++) {
            const cands = Array.from({ length: 30 }, (_, i) => ({ fileId: `f${i}`, score: r(), bytes: Math.floor(r() * 1000) + 1 }));
            const budget = Math.floor(r() * 5000);
            const sel = selectWithinBudget(cands, { budgetBytes: budget, maxItemBytes: 800 });
            assert.ok(sel.usedBytes <= budget);
            assert.equal(sel.usedBytes, sel.chosen.reduce((a, c) => a + c.bytes, 0));
            assert.ok(sel.chosen.every((c) => c.bytes <= 800));
            for (let i = 1; i < sel.chosen.length; i++) assert.ok(sel.chosen[i - 1].score >= sel.chosen[i].score);
        }
    });

    test('cached items use budget but are not re-warmed; minScore, maxItems, bad sizes and duplicates', () => {
        const sel = selectWithinBudget([
            { fileId: 'warm', score: 0.9, bytes: 30, cached: true },
            { fileId: 'cold', score: 0.8, bytes: 30 },
            { fileId: 'cold', score: 0.7, bytes: 30 },
            { fileId: 'zero', score: 0.95, bytes: 0 },
            { fileId: 'nan', score: 0.95, bytes: NaN },
            { fileId: 'unlikely', score: 0.05, bytes: 1 },
            { fileId: 'fourth', score: 0.6, bytes: 1 },
        ], { budgetBytes: 100, minScore: 0.1, maxItems: 2 });
        assert.deepEqual(sel.chosen.map((c) => c.fileId), ['warm', 'cold']);
        assert.deepEqual(sel.toWarm.map((c) => c.fileId), ['cold']);
        assert.equal(selectWithinBudget([{ fileId: 'x', score: 1, bytes: 5 }], { budgetBytes: 0 }).chosen.length, 0);
    });
});

describe('tagged byte cache', () => {
    test('LRU by bytes, per-item cap, TTL expiry', () => {
        const c = new ByteLruCache({ maxBytes: 100, maxItemBytes: 50, prefetchMaxBytes: 25 });
        assert.equal(c.set('big', buf(60), 'e', 0, { ttlMs: 1000 }), false);
        c.set('a', buf(40), 'e', 0, { ttlMs: 1000 });
        c.set('b', buf(40), 'e', 0, { ttlMs: 1000 });
        assert.ok(c.get('a', 1)); // a becomes most recent
        c.set('c', buf(40), 'e', 2, { ttlMs: 1000 }); // evicts b
        assert.equal(c.has('b', 3), false);
        assert.ok(c.has('a', 3) && c.has('c', 3));
        assert.equal(c.get('a', 2000), null); // expired
        assert.ok(c.stats().bytes <= 100);
    });

    test('prefetch sub-budget: evicts older unhit prefetched entries, never exceeds its share', () => {
        const c = new ByteLruCache({ maxBytes: 100, maxItemBytes: 50, prefetchMaxBytes: 30 });
        c.set('d', buf(50), 'e', 0, { ttlMs: 1e6 });
        assert.ok(c.set('p1', buf(20), 'e', 0, { source: 'predicted', ttlMs: 1e6 }));
        assert.ok(c.set('p2', buf(20), 'e', 1, { source: 'successor', ttlMs: 1e6 })); // evicts p1 (wasted)
        assert.equal(c.has('p1', 2), false);
        assert.ok(c.has('d', 2), 'demand entry survives prefetch pressure');
        assert.equal(c.set('p3', buf(40), 'e', 2, { source: 'predicted', ttlMs: 1e6 }), false); // > prefetch share
        const st = c.stats();
        assert.ok(st.prefetchBytes <= 30);
        assert.equal(st.prefetchWasted.predicted, 1);
    });

    test('first hit promotes and attributes a prefetched entry; prefetch of a resident key only extends TTL', () => {
        const c = new ByteLruCache({ maxBytes: 100, maxItemBytes: 50, prefetchMaxBytes: 30 });
        c.set('p', buf(20), 'e', 0, { source: 'predicted', ttlMs: 100 });
        const e = c.get('p', 10)!;
        assert.equal(e.source, 'predicted');
        assert.equal(e.promoted, true);
        c.get('p', 11);
        const st = c.stats();
        assert.equal(st.prefetchHits.predicted, 1);
        assert.equal(st.prefetchBytes, 0, 'promoted bytes no longer count against the prefetch share');
        c.set('d', buf(10), 'e', 20, { ttlMs: 10 });
        assert.ok(c.set('d', buf(10), 'other', 20, { source: 'successor', ttlMs: 1000 }));
        const d = c.peek('d', 500)!;
        assert.equal(d.source, 'demand');
        assert.equal(d.engine, 'e');
    });
});

describe('prediction metrics', () => {
    test('precision counts closed windows only; dedupes open predictions; recall per access', () => {
        const m = new PredictionMetrics({ horizonMs: 10 * HOUR_MS });
        assert.equal(m.predict('a', 'temporal', 0, HOUR_MS), true);
        assert.equal(m.predict('a', 'temporal', 60_000, HOUR_MS), false); // already open
        assert.equal(m.predict('a', 'sequential', 60_000, HOUR_MS), true); // other kind
        m.predict('b', 'temporal', 0, HOUR_MS);
        assert.equal(m.isPredicted('a', 30 * 60_000), true);
        assert.equal(m.access('a', 30 * 60_000), true);
        assert.equal(m.access('c', 30 * 60_000), false);
        let s = m.snapshot(30 * 60_000);
        assert.equal(s.precision.all.denominator, 0, 'nothing closed yet');
        s = m.snapshot(2 * HOUR_MS);
        assert.deepEqual([s.precision.temporal.numerator, s.precision.temporal.denominator], [1, 2]);
        assert.deepEqual([s.precision.sequential.numerator, s.precision.sequential.denominator], [1, 1]);
        assert.equal(s.recall.rate, 0.5);
        assert.equal(m.access('a', 2 * HOUR_MS), false, 'after the window: not covered');
    });

    test('hit rate split by predicted/unpredicted; TTFB percentiles per outcome; horizon drops old data', () => {
        const m = new PredictionMetrics({ horizonMs: HOUR_MS });
        m.request(0, true, 'hit', 1);
        m.request(0, true, 'miss', 100);
        m.request(0, false, 'miss', 120);
        m.request(0, false, 'disk', 5);
        let s = m.snapshot(1000);
        assert.equal(s.hitRate.predicted.rate, 0.5);
        assert.equal(s.hitRate.unpredicted.rate, 0);
        assert.equal(s.hitRate.all.denominator, 3, 'disk-streamed requests are not cacheable');
        assert.equal(s.ttfbMs.hit.p50, 1);
        assert.equal(s.ttfbMs.miss.p50, 110);
        s = m.snapshot(2 * HOUR_MS);
        assert.equal(s.requests, 0);
    });
});

describe('prediction engine', () => {
    test('observe returns learned successors and records them as sequential predictions', () => {
        const e = new PredictionEngine({ successorMinWeight: 1, successorMinProbability: 0.3 });
        for (let d = 0; d < 4; d++) {
            e.observe('report', MON + d * DAY_MS, 'u:a');
            e.observe('slides', MON + d * DAY_MS + 60_000, 'u:a');
        }
        const t = MON + 4 * DAY_MS;
        const next = e.observe('report', t, 'u:a');
        assert.deepEqual(next.map((s) => s.fileId), ['slides']);
        assert.equal(e.metrics.isPredicted('slides', t + 60_000), true);
        assert.equal(e.recordServed('slides', t + 60_000, 'hit', 1), true);
    });

    test('planTick predicts and records the habitual file before its hour', () => {
        const e = new PredictionEngine({ minScore: 0.2 });
        for (let w = 0; w < 4; w++) for (let d = 0; d < 5; d++) e.observe('report', MON + w * WEEK_MS + d * DAY_MS + 9 * HOUR_MS, null);
        const t = MON + 4 * WEEK_MS + 8.5 * HOUR_MS;
        assert.ok(e.planTick(t).some((p) => p.fileId === 'report'));
        assert.equal(e.metrics.isPredicted('report', t + 30 * 60_000), true);
    });
});
