/**
 * Exponential-decay primitives (pure; no Node/Next imports so the root test runner can load them).
 * A decayed counter stores its value as of time `t`; reading it at `now` multiplies by 2^(-(now-t)/halfLife).
 */

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
export const WEEK_MS = 7 * DAY_MS;
export const HOURS_PER_WEEK = 168;

export interface DecayedCounter {
    v: number;
    t: number;
}

/** 2^(-dt/halfLife); 1 for dt <= 0 or a non-positive half-life (no decay). */
export function decayFactor(dtMs: number, halfLifeMs: number): number {
    if (!(halfLifeMs > 0) || !(dtMs > 0)) return 1;
    return Math.pow(2, -dtMs / halfLifeMs);
}

export function counterAt(c: DecayedCounter | undefined, now: number, halfLifeMs: number): number {
    if (!c) return 0;
    return now >= c.t ? c.v * decayFactor(now - c.t, halfLifeMs) : c.v;
}

/** Adds `amount` at time `ts`. Out-of-order events (ts < c.t) are decayed forward to c.t instead. */
export function bump(c: DecayedCounter, ts: number, halfLifeMs: number, amount = 1): void {
    if (ts >= c.t) {
        c.v = c.v * decayFactor(ts - c.t, halfLifeMs) + amount;
        c.t = ts;
    } else {
        c.v += amount * decayFactor(c.t - ts, halfLifeMs);
    }
}

/**
 * Effective observation length (ms) of an exponentially decayed counter that has been collecting for `spanMs`:
 * ∫₀^span 2^(-x/H) dx = H/ln2 · (1 − 2^(−span/H)). A constant event rate r gives counter ≈ r · effectiveSpan.
 */
export function effectiveSpanMs(spanMs: number, halfLifeMs: number): number {
    if (!(halfLifeMs > 0)) return Math.max(spanMs, 1);
    return (halfLifeMs / Math.LN2) * (1 - Math.pow(2, -Math.max(spanMs, 0) / halfLifeMs));
}

/**
 * Number of "effective weeks" a weekly-periodic decayed histogram has observed after `spanMs`
 * (span floored at one week): Σ_{k<span/week} 2^(-k·week/H) = (1 − 2^(−span/H)) / (1 − 2^(−week/H)).
 * A bin that receives one event per week converges to this value.
 */
export function effectiveWeeks(spanMs: number, halfLifeMs: number): number {
    const span = Math.max(spanMs, WEEK_MS);
    if (!(halfLifeMs > 0)) return span / WEEK_MS;
    return (1 - Math.pow(2, -span / halfLifeMs)) / (1 - Math.pow(2, -WEEK_MS / halfLifeMs));
}

/** Hour-of-week bin 0..167 (Sunday 00:00 = 0) for `ts` shifted by a fixed timezone offset. */
export function hourOfWeek(ts: number, tzOffsetMinutes = 0): number {
    const d = new Date(ts + tzOffsetMinutes * 60_000);
    return d.getUTCDay() * 24 + d.getUTCHours();
}

/** Linear-interpolated percentile (p in [0,100]) of an unsorted sample; null when empty. */
export function percentile(values: number[], p: number): number | null {
    if (values.length === 0) return null;
    const s = [...values].sort((a, b) => a - b);
    const rank = (Math.min(Math.max(p, 0), 100) / 100) * (s.length - 1);
    const lo = Math.floor(rank);
    const hi = Math.ceil(rank);
    return s[lo] + (s[hi] - s[lo]) * (rank - lo);
}
