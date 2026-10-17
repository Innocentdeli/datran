/**
 * Prefetch selection under a byte budget (pure).
 * Greedy by score: take candidates in descending score order, skipping any that would overflow the budget
 * (smaller lower-ranked candidates may still fit). Probability-ordered greedy is what we want here rather than
 * score/byte density: a large file that is almost certainly requested beats several unlikely small ones.
 */

export interface PrefetchCandidate {
    fileId: string;
    score: number;
    /** Decoded size in bytes (what the stream cache will hold). */
    bytes: number;
    /** Already resident in the cache: counts against the budget but needs no warming. */
    cached?: boolean;
}

export interface SelectOptions {
    budgetBytes: number;
    /** Items above this size are never cached (stream cache's per-item cap). */
    maxItemBytes?: number;
    minScore?: number;
    maxItems?: number;
}

export interface Selection {
    /** Chosen candidates in score order (cached ones included). */
    chosen: PrefetchCandidate[];
    /** Chosen and not yet cached: these need warming. */
    toWarm: PrefetchCandidate[];
    usedBytes: number;
    skippedOverBudget: number;
}

export function selectWithinBudget(candidates: PrefetchCandidate[], opts: SelectOptions): Selection {
    const budget = Math.max(0, opts.budgetBytes);
    const maxItem = opts.maxItemBytes ?? Infinity;
    const minScore = opts.minScore ?? 0;
    const maxItems = opts.maxItems ?? Infinity;
    const sorted = candidates
        .filter((c) => Number.isFinite(c.bytes) && c.bytes > 0 && c.score >= minScore)
        .sort((a, b) => b.score - a.score || a.bytes - b.bytes || a.fileId.localeCompare(b.fileId));

    const chosen: PrefetchCandidate[] = [];
    const seen = new Set<string>();
    let used = 0;
    let skipped = 0;
    for (const c of sorted) {
        if (chosen.length >= maxItems) break;
        if (seen.has(c.fileId)) continue;
        if (c.bytes > maxItem || used + c.bytes > budget) {
            skipped++;
            continue;
        }
        seen.add(c.fileId);
        chosen.push(c);
        used += c.bytes;
    }
    return { chosen, toWarm: chosen.filter((c) => !c.cached), usedBytes: used, skippedOverBudget: skipped };
}
