import { scrubString } from './redact';

/**
 * Liveness / readiness logic (pure; dependencies injected so it can be unit tested). Routes:
 *   GET /api/health/live   -> 200 while the process can serve requests (no dependency checks).
 *   GET /api/health/ready  -> 200 when every REQUIRED dependency is OK, else 503:
 *       database: reachable (SELECT 1) and fully migrated (no pending/invalid migrations);
 *       redis:    reachable, only when REDIS_URL is configured;
 *       reactor:  GET /health answers 2xx, only when STORAGE_BACKEND=reactor.
 * Each check has its own timeout; checks run in parallel.
 */

export type CheckStatus = 'ok' | 'fail' | 'skipped';

export interface CheckResult {
    status: CheckStatus;
    latencyMs?: number;
    detail?: Record<string, unknown>;
    error?: string;
}

export interface DbHealth {
    backend: 'postgres' | 'local';
    pendingMigrations: number;
    migrationErrors: number;
}

export interface ReadinessDeps {
    checkDatabase: () => Promise<DbHealth>;
    /** Present only when Redis is configured. */
    pingRedis?: () => Promise<void>;
    /** Present only when the reactor is required (STORAGE_BACKEND=reactor). */
    pingReactor?: () => Promise<void>;
    timeoutMs?: number;
}

export interface ReadinessReport {
    status: 'ready' | 'not_ready';
    httpStatus: 200 | 503;
    checks: { database: CheckResult; redis: CheckResult; reactor: CheckResult };
}

export class HealthTimeoutError extends Error {
    constructor(ms: number) {
        super(`timed out after ${ms} ms`);
        this.name = 'HealthTimeoutError';
    }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new HealthTimeoutError(ms)), ms);
        (timer as { unref?: () => void }).unref?.();
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** Short, scrubbed error text (no credentials, tokens or IP addresses). */
export function describeError(e: unknown): string {
    const msg = e instanceof Error ? e.message : String(e);
    return scrubString(msg).slice(0, 200);
}

async function timed(fn: () => Promise<Record<string, unknown> | void>, ms: number): Promise<CheckResult> {
    const t0 = performance.now();
    try {
        const detail = await withTimeout(fn(), ms);
        return { status: 'ok', latencyMs: Math.round(performance.now() - t0), ...(detail ? { detail } : {}) };
    } catch (e) {
        return { status: 'fail', latencyMs: Math.round(performance.now() - t0), error: describeError(e) };
    }
}

export async function evaluateReadiness(deps: ReadinessDeps): Promise<ReadinessReport> {
    const ms = deps.timeoutMs ?? 2_000;
    const [database, redis, reactor] = await Promise.all([
        timed(async () => {
            const db = await deps.checkDatabase();
            const detail = { backend: db.backend, pendingMigrations: db.pendingMigrations };
            if (db.migrationErrors > 0) throw new Error(`migration state invalid (${db.migrationErrors} error(s))`);
            if (db.pendingMigrations > 0) throw new Error(`${db.pendingMigrations} pending migration(s)`);
            return detail;
        }, ms),
        deps.pingRedis ? timed(() => deps.pingRedis!(), ms) : Promise.resolve<CheckResult>({ status: 'skipped' }),
        deps.pingReactor ? timed(() => deps.pingReactor!(), ms) : Promise.resolve<CheckResult>({ status: 'skipped' }),
    ]);
    const ok = [database, redis, reactor].every((c) => c.status !== 'fail');
    return { status: ok ? 'ready' : 'not_ready', httpStatus: ok ? 200 : 503, checks: { database, redis, reactor } };
}

export function livenessReport(now = Date.now()) {
    return { status: 'ok' as const, uptimeSeconds: Math.round(process.uptime()), timestamp: new Date(now).toISOString() };
}
