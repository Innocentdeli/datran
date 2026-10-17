/**
 * Next.js instrumentation hook: runs once per server process (Node.js runtime only).
 *  - Expired-file cleanup + access-event retention. Env: CLEANUP_INTERVAL_MS (default 15 minutes; 0 disables).
 *  - Access prediction & prefetch (NETWORK_SPEC §5): rebuilds the model from persisted events, then warms predicted
 *    files every PREFETCH_INTERVAL_MS (default 60 s; 0 disables periodic prefetch, PREDICT_ENABLED=false disables all).
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;

    const g = globalThis as typeof globalThis & {
        __diocomCleanupTimer?: ReturnType<typeof setInterval>;
        __diocomPrefetchTimer?: ReturnType<typeof setInterval>;
    };

    if (!g.__diocomCleanupTimer) {
        const parsed = parseInt(process.env.CLEANUP_INTERVAL_MS || '', 10);
        const intervalMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 15 * 60 * 1000;
        if (intervalMs !== 0) {
            const { runCleanupJob } = await import('./lib/cleanup');
            const run = () => {
                runCleanupJob().catch((e) => console.error('[CLEANUP] Scheduled run failed:', e));
            };
            g.__diocomCleanupTimer = setInterval(run, Math.max(intervalMs, 60_000));
            g.__diocomCleanupTimer.unref?.();
            // First pass shortly after boot, without blocking startup.
            setTimeout(run, 30_000).unref?.();
        }
    }

    if (!g.__diocomPrefetchTimer && process.env.PREDICT_ENABLED !== 'false') {
        const { initPrediction, runPrefetchTick, prefetchIntervalMs } = await import('./lib/prefetcher');
        setTimeout(() => {
            initPrediction().catch((e) => console.error('[PREDICT] Model rebuild failed:', e));
        }, 5_000).unref?.();
        const intervalMs = prefetchIntervalMs();
        if (intervalMs > 0) {
            const tick = () => {
                runPrefetchTick().catch((e) => console.error('[PREDICT] Prefetch tick failed:', e));
            };
            g.__diocomPrefetchTimer = setInterval(tick, Math.max(intervalMs, 5_000));
            g.__diocomPrefetchTimer.unref?.();
        }
    }
}
