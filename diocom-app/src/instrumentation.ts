/**
 * Next.js instrumentation hook: runs once per server process (Node.js runtime only).
 *  - Database readiness: PostgreSQL + migrations (fatal in production), see src/db/index.ts.
 *  - Shared-state backend check (REDIS_URL / REQUIRE_REDIS, see src/lib/kv).
 *  - Expired-file cleanup + access-event retention. Env: CLEANUP_INTERVAL_MS (default 15 minutes; 0 disables).
 *    Scheduled on every instance; a distributed lock makes sure only one runs it at a time.
 *  - Access prediction & prefetch (NETWORK_SPEC §5): rebuilds the model from persisted events, then warms predicted
 *    files every PREFETCH_INTERVAL_MS (default 60 s; 0 disables periodic prefetch, PREDICT_ENABLED=false disables all).
 *  - Observability (src/lib/observability): OpenTelemetry tracing when OTEL_EXPORTER_OTLP_ENDPOINT is set (no-op
 *    otherwise); Prometheus registry + default Node metrics are created here so /api/metrics has data from boot.
 */
export async function register() {
    if (process.env.NEXT_RUNTIME !== 'nodejs') return;

    const { registerTracing } = await import('./lib/observability/tracing');
    const { getReactorUrl } = await import('./lib/reactorWorker');
    await registerTracing(getReactorUrl());
    const { getMetrics, createModuleLogger, recordCleanupRun } = await import('./lib/observability');
    getMetrics();
    const log = createModuleLogger('instrumentation');

    // Database (src/db): production refuses to start without a reachable, fully migrated PostgreSQL (the JSON store
    // is dev-only); DB_AUTO_MIGRATE=true applies pending migrations here. Not during `next build`.
    if (process.env.NEXT_PHASE !== 'phase-production-build') {
        const { ensureDatabaseReady } = await import('./db');
        await ensureDatabaseReady(); // throws -> Next.js aborts server startup
    }

    // Shared-state backend (src/lib/kv): REQUIRE_REDIS=true without REDIS_URL is fatal; production without
    // REDIS_URL logs a prominent single-instance warning. Connecting eagerly surfaces a bad REDIS_URL at boot.
    const { checkKvConfig, getKV, KvConfigError } = await import('./lib/kv');
    try {
        checkKvConfig(false);
        getKV();
    } catch (e) {
        // Thrown from register(): Next.js aborts server startup.
        if (e instanceof KvConfigError) log.fatal({ err: e }, 'shared state (kv) misconfigured');
        throw e;
    }

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
                const t0 = performance.now();
                const seconds = () => (performance.now() - t0) / 1000;
                runCleanupJob().then(
                    (acquired) => recordCleanupRun(acquired ? 'ok' : 'skipped', seconds()),
                    (err) => {
                        recordCleanupRun('error', seconds());
                        log.error({ err }, 'scheduled cleanup run failed');
                    },
                );
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
            initPrediction().catch((err) => log.error({ err }, 'prediction model rebuild failed'));
        }, 5_000).unref?.();
        const intervalMs = prefetchIntervalMs();
        if (intervalMs > 0) {
            const tick = () => {
                runPrefetchTick().catch((err) => log.error({ err }, 'prefetch tick failed'));
            };
            g.__diocomPrefetchTimer = setInterval(tick, Math.max(intervalMs, 5_000));
            g.__diocomPrefetchTimer.unref?.();
        }
    }
}
