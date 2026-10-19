import client, { type Registry } from 'prom-client';

/**
 * Prometheus metrics (prom-client). One registry per process, kept on globalThis (route handlers and instrumentation
 * are separate bundles; registering a metric twice would throw). Exposed by GET /api/metrics (METRICS_TOKEN).
 *
 * Multi-instance: every app instance exposes ONLY its own counters; Prometheus scrapes each instance (see
 * deploy/prometheus/prometheus.yml, DNS service discovery over the scaled `app` service) and aggregates with sum().
 *
 * Cardinality: every label value goes through a bounded guard. HTTP metrics are labelled with the ROUTE TEMPLATE
 * passed to withObservability() (e.g. "/api/inbox/[id]"), never the raw URL; methods/status codes are normalised;
 * free-form labels (rate-limit scope, auth method, ...) are capped at MAX_LABEL_VALUES distinct values, after which
 * new values collapse into "other".
 */

export const MAX_LABEL_VALUES = 64;
const OTHER = 'other';

/** Caps the number of distinct values a label can take; values must also match a safe charset. */
export class LabelGuard {
    private readonly seen = new Set<string>();
    constructor(private readonly max = MAX_LABEL_VALUES, private readonly pattern = /^[A-Za-z0-9_.:/\[\]\-]{1,80}$/) {}
    value(v: string | null | undefined): string {
        if (!v || !this.pattern.test(v)) return OTHER;
        if (this.seen.has(v)) return v;
        if (this.seen.size >= this.max) return OTHER;
        this.seen.add(v);
        return v;
    }
    get size(): number {
        return this.seen.size;
    }
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
export function normalizeMethod(m: string | null | undefined): string {
    const u = (m || '').toUpperCase();
    return METHODS.has(u) ? u : OTHER;
}

export function normalizeStatus(s: number): string {
    return Number.isInteger(s) && s >= 100 && s <= 599 ? String(s) : OTHER;
}

/**
 * Route template label: strips any query/fragment and rejects anything that looks like a concrete URL segment
 * (long hex/uuid/numeric ids) so a mistaken raw path cannot explode cardinality.
 */
export function normalizeRoute(route: string | null | undefined): string {
    if (!route) return OTHER;
    const path = route.split(/[?#]/)[0];
    if (!/^\/[A-Za-z0-9_.\-\/\[\]]*$/.test(path) || path.length > 80) return OTHER;
    const concrete = path.split('/').some((seg) => /^\d+$/.test(seg) || /^[0-9a-f-]{16,}$/i.test(seg) || seg.length > 40);
    return concrete ? OTHER : path;
}

const SQL_OPS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK', 'CREATE', 'ALTER', 'DROP', 'SET', 'LOCK']);
export function sqlOperation(sql: string): string {
    const m = /^\s*([A-Za-z]+)/.exec(sql || '');
    const op = m ? m[1].toUpperCase() : '';
    return SQL_OPS.has(op) ? op.toLowerCase() : OTHER;
}

export interface AppMetrics {
    registry: Registry;
    httpRequests: client.Counter<'route' | 'method' | 'status'>;
    httpDuration: client.Histogram<'route' | 'method' | 'status'>;
    httpInFlight: client.Gauge<'route'>;
    uploads: client.Counter<'outcome' | 'backend'>;
    uploadBytes: client.Counter<'backend'>;
    downloads: client.Counter<'source'>;
    downloadBytes: client.Counter<'source'>;
    reactorDuration: client.Histogram<'op' | 'outcome'>;
    reactorErrors: client.Counter<'op' | 'reason'>;
    streamCache: client.Counter<'result'>;
    prefetchWarms: client.Counter<'outcome'>;
    rateLimitRejections: client.Counter<'scope' | 'reason'>;
    authAttempts: client.Counter<'method' | 'result'>;
    kvErrors: client.Counter<'op'>;
    dbDuration: client.Histogram<'backend' | 'op' | 'outcome'>;
    cleanupRuns: client.Counter<'outcome'>;
    cleanupDuration: client.Histogram<'outcome'>;
    cleanupDeleted: client.Counter;
    guards: Record<'route' | 'scope' | 'authMethod' | 'source' | 'op' | 'reason' | 'outcome' | 'backend', LabelGuard>;
}

export function createMetrics(opts: { registry?: Registry; defaultMetrics?: boolean } = {}): AppMetrics {
    const registry = opts.registry ?? new client.Registry();
    if (opts.defaultMetrics !== false) client.collectDefaultMetrics({ register: registry });
    const registers = [registry];
    const httpBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];
    return {
        registry,
        httpRequests: new client.Counter({
            name: 'http_requests_total', help: 'HTTP requests handled, by route template, method and status.',
            labelNames: ['route', 'method', 'status'], registers,
        }),
        httpDuration: new client.Histogram({
            name: 'http_request_duration_seconds',
            help: 'Time until the route handler returned its response (time to headers for streamed bodies).',
            labelNames: ['route', 'method', 'status'], buckets: httpBuckets, registers,
        }),
        httpInFlight: new client.Gauge({
            name: 'http_requests_in_flight', help: 'Requests currently inside a route handler.', labelNames: ['route'], registers,
        }),
        uploads: new client.Counter({
            name: 'diocom_uploads_total', help: 'Upload attempts by outcome (ok|rejected|error) and storage backend.',
            labelNames: ['outcome', 'backend'], registers,
        }),
        uploadBytes: new client.Counter({
            name: 'diocom_upload_bytes_total', help: 'Bytes received in successful uploads (original size).',
            labelNames: ['backend'], registers,
        }),
        downloads: new client.Counter({
            name: 'diocom_downloads_total', help: 'Counted downloads (full or from byte 0) by source.', labelNames: ['source'], registers,
        }),
        downloadBytes: new client.Counter({
            name: 'diocom_download_bytes_total', help: 'Response body bytes sent by /api/stream (declared length).',
            labelNames: ['source'], registers,
        }),
        reactorDuration: new client.Histogram({
            name: 'diocom_reactor_request_duration_seconds', help: 'Latency of HTTP calls to the Rust reactor.',
            labelNames: ['op', 'outcome'], buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30], registers,
        }),
        reactorErrors: new client.Counter({
            name: 'diocom_reactor_errors_total', help: 'Failed reactor calls (network, timeout, non-2xx).',
            labelNames: ['op', 'reason'], registers,
        }),
        streamCache: new client.Counter({
            name: 'diocom_stream_cache_requests_total', help: 'Decoded-bytes cache lookups by /api/stream (hit|miss).',
            labelNames: ['result'], registers,
        }),
        prefetchWarms: new client.Counter({
            name: 'diocom_prefetch_warms_total', help: 'Prefetch warm jobs by outcome (warmed_<source>|skipped_<reason>|failed).',
            labelNames: ['outcome'], registers,
        }),
        rateLimitRejections: new client.Counter({
            name: 'diocom_rate_limit_rejections_total', help: 'Requests refused by the rate limiter (limited|unavailable).',
            labelNames: ['scope', 'reason'], registers,
        }),
        authAttempts: new client.Counter({
            name: 'diocom_auth_attempts_total', help: 'Authentication attempts by method and result.',
            labelNames: ['method', 'result'], registers,
        }),
        kvErrors: new client.Counter({
            name: 'diocom_kv_errors_total', help: 'Shared KV (Redis) errors by operation.', labelNames: ['op'], registers,
        }),
        dbDuration: new client.Histogram({
            name: 'diocom_db_query_duration_seconds', help: 'Database query duration by backend and SQL operation.',
            labelNames: ['backend', 'op', 'outcome'], buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5], registers,
        }),
        cleanupRuns: new client.Counter({
            name: 'diocom_cleanup_runs_total', help: 'Expired-file cleanup job runs (ok|skipped|error).', labelNames: ['outcome'], registers,
        }),
        cleanupDuration: new client.Histogram({
            name: 'diocom_cleanup_duration_seconds', help: 'Cleanup job duration.', labelNames: ['outcome'],
            buckets: [0.1, 0.5, 1, 5, 15, 60, 300, 900], registers,
        }),
        cleanupDeleted: new client.Counter({
            name: 'diocom_cleanup_deleted_files_total', help: 'Expired files purged by the cleanup job.', registers,
        }),
        guards: {
            route: new LabelGuard(200),
            scope: new LabelGuard(),
            authMethod: new LabelGuard(16),
            source: new LabelGuard(16),
            op: new LabelGuard(32),
            reason: new LabelGuard(32),
            outcome: new LabelGuard(48),
            backend: new LabelGuard(8),
        },
    };
}

const g = globalThis as typeof globalThis & { __diocomMetrics?: AppMetrics };

/** Process-wide metrics (default Node metrics enabled on first use). */
export function getMetrics(): AppMetrics {
    return g.__diocomMetrics ?? (g.__diocomMetrics = createMetrics());
}

/** Test hook. */
export function setMetricsForTesting(m: AppMetrics | undefined): void {
    g.__diocomMetrics = m;
}

// -------------------------------------------------------------------------------------------------------------------
// Recording helpers (never throw: metrics must not break a request).
// -------------------------------------------------------------------------------------------------------------------

function safe(fn: () => void): void {
    try {
        fn();
    } catch {
        /* ignore */
    }
}

export function recordHttpRequest(route: string, method: string, status: number, seconds: number, m = getMetrics()): void {
    safe(() => {
        const labels = { route: m.guards.route.value(normalizeRoute(route)), method: normalizeMethod(method), status: normalizeStatus(status) };
        m.httpRequests.inc(labels);
        m.httpDuration.observe(labels, seconds);
    });
}

/** For the upload pipeline (ingest / resumable uploads): call once per finished upload. */
export function recordUpload(o: { outcome: 'ok' | 'rejected' | 'error'; bytes?: number; backend?: string }, m = getMetrics()): void {
    safe(() => {
        const backend = m.guards.backend.value(o.backend || 'unknown');
        m.uploads.inc({ outcome: o.outcome, backend });
        if (o.outcome === 'ok' && o.bytes && o.bytes > 0) m.uploadBytes.inc({ backend }, o.bytes);
    });
}

export function recordDownload(o: { source: string; bytes?: number; counted?: boolean }, m = getMetrics()): void {
    safe(() => {
        const source = m.guards.source.value(o.source);
        if (o.counted !== false) m.downloads.inc({ source });
        if (o.bytes && o.bytes > 0) m.downloadBytes.inc({ source }, o.bytes);
    });
}

export function recordReactorCall(op: string, seconds: number, outcome: 'ok' | 'error', reason?: string, m = getMetrics()): void {
    safe(() => {
        const o = m.guards.op.value(op);
        m.reactorDuration.observe({ op: o, outcome }, seconds);
        if (outcome === 'error') m.reactorErrors.inc({ op: o, reason: m.guards.reason.value(reason || 'error') });
    });
}

/** Classifies a fetch failure into a small fixed set of reasons. */
export function reactorErrorReason(e: unknown): string {
    if (e && typeof e === 'object') {
        const name = (e as { name?: string }).name;
        if (name === 'TimeoutError') return 'timeout';
        if (name === 'AbortError') return 'aborted';
        const msg = String((e as { message?: string }).message || '');
        const status = /returned (\d{3})/.exec(msg);
        if (status) return `http_${status[1][0]}xx`;
        if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket/i.test(msg + String((e as { cause?: unknown }).cause ?? ''))) return 'network';
    }
    return 'error';
}

/** Times a reactor call; non-2xx responses count as errors when `isOk` says so. Rethrows. */
export async function observeReactorCall<T>(op: string, fn: () => Promise<T>, isOk?: (r: T) => boolean): Promise<T> {
    const t0 = performance.now();
    try {
        const r = await fn();
        const ok = isOk ? isOk(r) : true;
        const status = (r as { status?: unknown } | null)?.status;
        recordReactorCall(op, (performance.now() - t0) / 1000, ok ? 'ok' : 'error', ok ? undefined : typeof status === 'number' ? `http_${String(status)[0]}xx` : 'error');
        return r;
    } catch (e) {
        recordReactorCall(op, (performance.now() - t0) / 1000, 'error', reactorErrorReason(e));
        throw e;
    }
}

export function recordStreamCache(result: 'hit' | 'miss', m = getMetrics()): void {
    safe(() => m.streamCache.inc({ result }));
}

export function recordPrefetchWarm(outcome: string, m = getMetrics()): void {
    safe(() => m.prefetchWarms.inc({ outcome: m.guards.outcome.value(outcome) }));
}

/** `identifier` is a rate-limit key such as "unlock:ip:..."; only its first segment (the scope) becomes a label. */
export function recordRateLimitRejection(identifier: string, reason: 'limited' | 'unavailable', m = getMetrics()): void {
    safe(() => m.rateLimitRejections.inc({ scope: m.guards.scope.value(identifier.split(':')[0]), reason }));
}

export function recordAuth(method: string, result: 'success' | 'failure' | 'rate_limited' | 'error', m = getMetrics()): void {
    safe(() => m.authAttempts.inc({ method: m.guards.authMethod.value(method), result }));
}

export function recordKvError(op: string, m = getMetrics()): void {
    safe(() => m.kvErrors.inc({ op: m.guards.op.value(op) }));
}

export function recordDbQuery(backend: string, sql: string, seconds: number, ok: boolean, m = getMetrics()): void {
    safe(() => m.dbDuration.observe({ backend: m.guards.backend.value(backend), op: sqlOperation(sql), outcome: ok ? 'ok' : 'error' }, seconds));
}

export function recordCleanupRun(outcome: 'ok' | 'skipped' | 'error', seconds: number, deleted = 0, m = getMetrics()): void {
    safe(() => {
        m.cleanupRuns.inc({ outcome });
        if (outcome !== 'skipped') m.cleanupDuration.observe({ outcome }, seconds);
        if (deleted > 0) m.cleanupDeleted.inc(deleted);
    });
}
