import { createHmac } from 'crypto';
import { getToken } from 'next-auth/jwt';
import { FileRepository, FileRecord } from '@/db/files';
import { getAppSecret, getClientIp } from '@/lib/security';
import type { MetricsSnapshot } from '@/lib/predict/metrics';
import {
    PredictionEngine, PredictionModel, ModelConfig, EngineConfig, CacheOutcome, CacheSource, selectWithinBudget,
} from '@/lib/predict';
import {
    getStreamCache, isCacheableRecord, decodeStoredFile, cacheDecoded, prefetchMaxBytes,
} from '@/lib/streamCache';
import {
    enqueueAccessEvent, loadRecentAccessEvents, pruneAccessEvents, accessEventStats, maxEvents,
} from '@/lib/accessEvents';
import { parseReactorStoragePath } from '@/lib/storage/reactorStoreCore';
import { touchStoreFile } from '@/lib/storage/reactorStore';
import { getKV, instanceId, type KV } from '@/lib/kv';
import { createModuleLogger } from '@/lib/observability/logger';
import { recordPrefetchWarm } from '@/lib/observability/metrics';

const log = createModuleLogger('predict');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Access prediction & prefetch runtime (NETWORK_SPEC §5).
 *
 *  - recordStreamAccess(): called by /api/stream for each counted access (full request or range from byte 0).
 *    Synchronous accounting only; actor resolution, model update, event persistence and successor warming run
 *    asynchronously so the response is never delayed.
 *  - runPrefetchTick(): every PREFETCH_INTERVAL_MS (instrumentation.ts) warms the top predicted files for the next
 *    PREDICT_WINDOW_MS into the stream cache within PREFETCH_MAX_BYTES.
 *  - On each access the top-k Markov successors (PREFETCH_SUCCESSORS) are warmed.
 *  - Warming = the stream route's own load + decode path (local disk + reactor/TS decoder). Expired, deleted,
 *    external and uncompressed files are skipped. Access checks are untouched: they run on every serve.
 *  - Reactor-store files (storage_path `reactor:<id>`): warming issues a reactor GET so the reactor records demand
 *    for data gravity (NETWORK_SPEC §4/§5). Files that fit the cache/prefetch budget are read fully and cached;
 *    larger ones get a small ranged GET ("touch") that is drained, never cached.
 *  - The model is rebuilt from persisted events on startup; all state is bounded.
 *
 * Multiple instances (REDIS_URL set; see src/lib/kv):
 *  - The stream cache stays per instance (each instance warms its own cache; share ids are immutable and every
 *    serve re-checks the DB record, so a stale local entry can never be served for a deleted/expired file).
 *  - Every observed access is broadcast on `predict:observe`; other instances feed it into their model (no metrics,
 *    no successor warming there), so all models learn from all traffic. Only the serving instance persists it.
 *  - forgetFile() is broadcast on `predict:forget` so every instance drops the file from model/meta/cache.
 *  - Reactor "touches" (demand signals for files too large to cache) are de-duplicated cluster-wide with a short
 *    SET NX key, so N instances do not report the same demand N times.
 *  - Each instance publishes its metrics snapshot (`predict:status:<instance>`); the admin endpoint aggregates them.
 */

function envInt(name: string, fallback: number, min = 0): number {
    const n = parseInt(process.env[name] || '', 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
}
function envFloat(name: string, fallback: number): number {
    const n = parseFloat(process.env[name] || '');
    return Number.isFinite(n) ? n : fallback;
}

export function predictionEnabled(): boolean {
    return process.env.PREDICT_ENABLED !== 'false';
}

export function prefetchIntervalMs(): number {
    return envInt('PREFETCH_INTERVAL_MS', 60_000);
}

function engineConfig(): Partial<EngineConfig> {
    return {
        windowMs: envInt('PREDICT_WINDOW_MS', 3_600_000, 60_000),
        minScore: Math.min(Math.max(envFloat('PREDICT_MIN_SCORE', 0.2), 0), 1),
        maxPredictions: envInt('PREFETCH_MAX_FILES', 50, 1),
        successorsK: envInt('PREFETCH_SUCCESSORS', 3),
        metricsHorizonMs: envInt('PREDICT_METRICS_WINDOW_MS', 24 * 3_600_000, 60_000),
    };
}

function modelConfig(): Partial<ModelConfig> {
    return {
        // Default: the server's current UTC offset (hour-of-week bins in local time).
        tzOffsetMinutes: envInt('PREDICT_TZ_OFFSET_MINUTES', -new Date().getTimezoneOffset(), -24 * 60),
        maxFiles: envInt('PREDICT_MAX_FILES', 5000, 10),
    };
}

const INTENT_TTL_MS = 10 * 60_000;
const MAX_WARM_QUEUE = 200;
const MAX_PENDING_OBSERVE = 10_000;
const META_TTL_MS = 60_000;
const MAX_META = 5_000;
const MAX_REACTOR_TOUCHES_PER_TICK = 10;
const TOUCH_DEDUP_MS = 60_000;
const OBSERVE_CHANNEL = 'predict:observe';
const FORGET_CHANNEL = 'predict:forget';
const STATUS_INSTANCES_KEY = 'predict:instances';
const statusKey = (id: string) => `predict:status:${id}`;
const MAX_STATUS_INSTANCES = 256;

interface WarmJob { fileId: string; source: Exclude<CacheSource, 'demand'>; ttlMs: number }

interface TopPrediction {
    shareId: string;
    name: string | null;
    score: number;
    lambdaTemporal: number;
    lambdaRecency: number;
    selected: boolean;
    cached: boolean;
}

interface Runtime {
    engine: PredictionEngine;
    ready: boolean;
    init: Promise<void> | null;
    pending: { fileId: string; ts: number; actor: string | null }[];
    warmQueue: WarmJob[];
    clusterSync: boolean;
    warmKeys: Set<string>;
    warmActive: number;
    tickRunning: boolean;
    meta: Map<string, { rec: FileRecord | null; at: number }>;
    top: TopPrediction[];
    stats: {
        rebuiltEvents: number;
        rebuildMs: number | null;
        rebuildError: string | null;
        ticks: number;
        lastTickAt: number | null;
        lastTickMs: number | null;
        warmed: Record<string, number>;
        warmedBytes: number;
        warmFailed: number;
        warmSkipped: Record<string, number>;
        warmDroppedQueueFull: number;
        lastWarmError: string | null;
        /** Reactor-store warms: full reads (cached) and ranged touches (demand signal only). */
        reactorReads: number;
        reactorTouches: number;
    };
}

const g = globalThis as typeof globalThis & { __diocomPrefetch?: Runtime };

function rt(): Runtime {
    if (!g.__diocomPrefetch) {
        g.__diocomPrefetch = {
            engine: new PredictionEngine(engineConfig(), modelConfig()),
            ready: false,
            init: null,
            pending: [],
            warmQueue: [],
            clusterSync: false,
            warmKeys: new Set(),
            warmActive: 0,
            tickRunning: false,
            meta: new Map(),
            top: [],
            stats: {
                rebuiltEvents: 0, rebuildMs: null, rebuildError: null, ticks: 0, lastTickAt: null, lastTickMs: null,
                warmed: {}, warmedBytes: 0, warmFailed: 0, warmSkipped: {}, warmDroppedQueueFull: 0, lastWarmError: null,
                reactorReads: 0, reactorTouches: 0,
            },
        };
    }
    if (!g.__diocomPrefetch.clusterSync) {
        g.__diocomPrefetch.clusterSync = true;
        void startClusterSync();
    }
    return g.__diocomPrefetch;
}

/** Shared KV only when it is Redis (in-memory means one process: nothing to sync). */
function clusterKV(): KV | null {
    try {
        const kv = getKV();
        return kv.backend === 'redis' ? kv : null;
    } catch {
        return null;
    }
}

async function startClusterSync() {
    const kv = clusterKV();
    if (!kv) return;
    const me = instanceId();
    try {
        await kv.subscribe(OBSERVE_CHANNEL, (raw) => {
            try {
                const m = JSON.parse(raw) as { o: string; f: string; t: number; a: string | null };
                if (m.o === me || typeof m.f !== 'string' || typeof m.t !== 'number') return;
                const r = rt();
                if (!r.ready) {
                    if (r.pending.length < MAX_PENDING_OBSERVE) r.pending.push({ fileId: m.f, ts: m.t, actor: m.a });
                    return;
                }
                r.engine.model.observe(m.f, m.t, m.a);
            } catch { /* malformed */ }
        });
        await kv.subscribe(FORGET_CHANNEL, (raw) => {
            try {
                const m = JSON.parse(raw) as { o: string; s: string };
                if (m.o !== me && typeof m.s === 'string') forgetLocal(m.s);
            } catch { /* malformed */ }
        });
    } catch (e) {
        log.warn({ error: errMsg(e) }, 'cluster sync unavailable');
        if (g.__diocomPrefetch) g.__diocomPrefetch.clusterSync = false; // retry on next access
    }
}

function broadcast(channel: string, payload: object) {
    const kv = clusterKV();
    if (!kv) return;
    kv.publish(channel, JSON.stringify({ o: instanceId(), ...payload }))
        .catch((e) => log.warn({ error: errMsg(e) }, 'broadcast failed'));
}

function warmConcurrency(): number {
    return envInt('PREFETCH_CONCURRENCY', 2, 1);
}

// ---------------------------------------------------------------------------
// Startup: rebuild the model from persisted events
// ---------------------------------------------------------------------------

export function initPrediction(): Promise<void> {
    const r = rt();
    if (!r.init) {
        r.init = (async () => {
            const t0 = Date.now();
            const model = new PredictionModel(modelConfig());
            try {
                const rows = await loadRecentAccessEvents(t0, maxEvents());
                // Live events seen while loading may already be in the DB; replay them once, from `pending`.
                const pendingKeys = new Set(r.pending.map((p) => `${p.fileId}\0${p.ts}\0${p.actor ?? ''}`));
                for (const row of rows) {
                    if (pendingKeys.has(`${row.file_id}\0${row.ts}\0${row.actor}`)) continue;
                    model.observe(row.file_id, row.ts, row.actor || null);
                }
                r.stats.rebuiltEvents = rows.length;
            } catch (e) {
                r.stats.rebuildError = e instanceof Error ? e.message : String(e);
                log.warn({ error: r.stats.rebuildError }, 'could not rebuild model from access events');
            }
            for (const p of r.pending) model.observe(p.fileId, p.ts, p.actor);
            r.pending = [];
            r.engine.model = model;
            r.ready = true;
            r.stats.rebuildMs = Date.now() - t0;
            log.info({ trackedFiles: model.trackedFiles, events: r.stats.rebuiltEvents, rebuildMs: r.stats.rebuildMs }, 'prediction model ready');
        })();
    }
    return r.init;
}

// ---------------------------------------------------------------------------
// Actor identity (never stores raw IPs)
// ---------------------------------------------------------------------------

function parseCookies(header: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i <= 0) continue;
        const k = part.slice(0, i).trim();
        if (k.startsWith('next-auth.session-token') || k.startsWith('__Secure-next-auth.session-token')) {
            try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* malformed cookie */ }
        }
    }
    return out;
}

async function resolveActor(cookieHeader: string | null, ip: string, ua: string): Promise<string | null> {
    let secret: string;
    try {
        secret = getAppSecret();
    } catch {
        return null;
    }
    const cookies = parseCookies(cookieHeader);
    if (Object.keys(cookies).length > 0) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const token = await getToken({ req: { headers: {}, cookies } as any, secret });
            const id = token && typeof (token as { id?: unknown }).id === 'string' ? (token as { id: string }).id : null;
            if (id) return `u:${id}`;
        } catch { /* fall through to anonymous */ }
    }
    const h = createHmac('sha256', secret).update(`predict-actor\0${ip}\0${ua}`).digest('base64url');
    return `a:${h.slice(0, 22)}`;
}

// ---------------------------------------------------------------------------
// Serving hook
// ---------------------------------------------------------------------------

export interface StreamAccess {
    request: Request;
    fileId: string;
    ts: number;
    /** 'hit'/'miss' for cacheable (decoded) files, 'disk' for streamed files, null when not served by us (redirect). */
    outcome: CacheOutcome | null;
    ttfbMs: number;
}

/** Records a counted stream access. Synchronous bookkeeping only; never throws. */
export function recordStreamAccess(a: StreamAccess): void {
    if (!predictionEnabled()) return;
    try {
        const r = rt();
        if (a.outcome) r.engine.recordServed(a.fileId, a.ts, a.outcome, a.ttfbMs);
        else r.engine.metrics.access(a.fileId, a.ts);

        const cookieHeader = a.request.headers.get('cookie');
        const ua = a.request.headers.get('user-agent') || '';
        const ip = getClientIp(a.request);
        void resolveActor(cookieHeader, ip, ua)
            .then((actor) => onObserved(a.fileId, a.ts, actor))
            .catch((e) => log.warn({ error: errMsg(e) }, 'access hook failed'));
    } catch (e) {
        log.warn({ error: errMsg(e) }, 'access hook failed');
    }
}

function onObserved(fileId: string, ts: number, actor: string | null) {
    const r = rt();
    enqueueAccessEvent({ file_id: fileId, ts, actor: actor ?? '' });
    broadcast(OBSERVE_CHANNEL, { f: fileId, t: ts, a: actor });
    if (!r.ready) {
        if (r.pending.length < MAX_PENDING_OBSERVE) r.pending.push({ fileId, ts, actor });
        void initPrediction();
        return;
    }
    const successors = r.engine.observe(fileId, ts, actor);
    for (const s of successors) enqueueWarm({ fileId: s.fileId, source: 'successor', ttlMs: r.engine.model.cfg.markovWindowMs });
}

/** A viewer page for this file was opened: its stream request is likely imminent. */
export function warmIntent(fileId: string): boolean {
    if (!predictionEnabled()) return false;
    const r = rt();
    r.engine.metrics.predict(fileId, 'intent', Date.now(), INTENT_TTL_MS);
    return enqueueWarm({ fileId, source: 'intent', ttlMs: INTENT_TTL_MS });
}

/** Drops a deleted/expired file from the model, metadata memo and cache, on every instance. */
export function forgetFile(shareId: string) {
    forgetLocal(shareId);
    broadcast(FORGET_CHANNEL, { s: shareId });
}

function forgetLocal(shareId: string) {
    const r = g.__diocomPrefetch;
    if (r) {
        r.engine.model.forget(shareId);
        r.meta.delete(shareId);
    }
    getStreamCache().delete(shareId);
}

// ---------------------------------------------------------------------------
// Warming (bounded queue + concurrency limit)
// ---------------------------------------------------------------------------

function skip(reason: string) {
    const s = rt().stats.warmSkipped;
    s[reason] = (s[reason] || 0) + 1;
    recordPrefetchWarm(`skipped_${reason}`);
}

function enqueueWarm(job: WarmJob): boolean {
    const r = rt();
    const cache = getStreamCache();
    const now = Date.now();
    if (cache.has(job.fileId, now)) {
        cache.extend(job.fileId, now + job.ttlMs, now);
        return true;
    }
    if (r.warmKeys.has(job.fileId)) return true;
    if (r.warmQueue.length >= MAX_WARM_QUEUE) {
        r.stats.warmDroppedQueueFull++;
        return false;
    }
    r.warmKeys.add(job.fileId);
    r.warmQueue.push(job);
    pumpWarm();
    return true;
}

function pumpWarm() {
    const r = rt();
    while (r.warmActive < warmConcurrency() && r.warmQueue.length > 0) {
        const job = r.warmQueue.shift()!;
        r.warmActive++;
        warmOne(job)
            .catch((e) => {
                r.stats.warmFailed++;
                recordPrefetchWarm('failed');
                r.stats.lastWarmError = e instanceof Error ? e.message : String(e);
            })
            .finally(() => {
                r.warmActive--;
                r.warmKeys.delete(job.fileId);
                pumpWarm();
            });
    }
}

async function warmOne(job: WarmJob): Promise<void> {
    const r = rt();
    const cache = getStreamCache();
    // Fresh lookup right before warming: never warm a deleted or expired file.
    const rec = await FileRepository.findByShareId(job.fileId);
    if (!rec) { forgetFile(job.fileId); return skip('deleted'); }
    if (rec.expires_at && Date.now() > Number(rec.expires_at)) { forgetFile(job.fileId); return skip('expired'); }
    if (!isCacheableRecord(rec)) return skip('not_cacheable');
    const size = Number(rec.file_size) || 0;
    const storeId = parseReactorStoragePath(rec.storage_path);
    if (size > cache.opts.maxItemBytes || size > cache.opts.prefetchMaxBytes) {
        if (!storeId) return skip('too_large');
        // Too big to cache: still tell the reactor this file is wanted here (gravity), without buffering it.
        // One touch per file per TOUCH_DEDUP_MS across all instances.
        const kv = clusterKV();
        if (kv && !(await kv.setNX(`prefetch:touch:${storeId}`, instanceId(), TOUCH_DEDUP_MS).catch(() => true))) {
            return skip('touch_dedup');
        }
        if (!(await touchStoreFile(storeId))) return skip('not_in_store');
        r.stats.reactorTouches++;
        return skip('too_large_touched');
    }
    if (cache.has(job.fileId, Date.now())) {
        cache.extend(job.fileId, Date.now() + job.ttlMs, Date.now());
        return skip('already_cached');
    }
    const decoded = await decodeStoredFile(rec);
    if (storeId) r.stats.reactorReads++;
    if (cacheDecoded(rec.share_id, decoded, job.source, job.ttlMs)) {
        r.stats.warmed[job.source] = (r.stats.warmed[job.source] || 0) + 1;
        recordPrefetchWarm(`warmed_${job.source}`);
        r.stats.warmedBytes += decoded.data.length;
    } else {
        skip('over_budget');
    }
}

// ---------------------------------------------------------------------------
// Periodic prefetch
// ---------------------------------------------------------------------------

async function lookupMeta(shareId: string, now: number): Promise<FileRecord | null> {
    const r = rt();
    const m = r.meta.get(shareId);
    if (m && now - m.at < META_TTL_MS) return m.rec;
    const rec = (await FileRepository.findByShareId(shareId)) ?? null;
    if (r.meta.size >= MAX_META) r.meta.delete(r.meta.keys().next().value as string);
    r.meta.set(shareId, { rec, at: now });
    return rec;
}

export async function runPrefetchTick(): Promise<void> {
    if (!predictionEnabled()) return;
    const r = rt();
    if (r.tickRunning) return;
    r.tickRunning = true;
    const t0 = Date.now();
    try {
        await initPrediction();
        const now = Date.now();
        const cache = getStreamCache();
        cache.sweep(now);
        const preds = r.engine.planTick(now);

        const candidates: { fileId: string; score: number; bytes: number; cached: boolean }[] = [];
        const reactorTooLarge: string[] = [];
        const names = new Map<string, string | null>();
        for (const p of preds) {
            const rec = await lookupMeta(p.fileId, now);
            if (!rec) { forgetFile(p.fileId); continue; }
            if (rec.expires_at && now > Number(rec.expires_at)) { forgetFile(p.fileId); continue; }
            names.set(p.fileId, rec.original_name ?? null);
            if (!isCacheableRecord(rec)) continue;
            if (parseReactorStoragePath(rec.storage_path) && (Number(rec.file_size) || 0) > cache.opts.maxItemBytes) {
                reactorTooLarge.push(p.fileId);
                continue;
            }
            candidates.push({ fileId: p.fileId, score: p.score, bytes: Number(rec.file_size) || 0, cached: cache.has(p.fileId, now) });
        }
        const sel = selectWithinBudget(candidates, {
            budgetBytes: prefetchMaxBytes(),
            maxItemBytes: cache.opts.maxItemBytes,
        });
        const windowMs = r.engine.cfg.windowMs;
        for (const c of sel.chosen) {
            if (c.cached) cache.extend(c.fileId, now + windowMs, now);
            else enqueueWarm({ fileId: c.fileId, source: 'predicted', ttlMs: windowMs });
        }
        // Predicted reactor files too large to cache: a ranged touch so the reactor's gravity sees the demand.
        for (const fileId of reactorTooLarge.slice(0, MAX_REACTOR_TOUCHES_PER_TICK)) {
            enqueueWarm({ fileId, source: 'predicted', ttlMs: windowMs });
        }

        const chosen = new Set(sel.chosen.map((c) => c.fileId));
        r.top = preds.slice(0, 15).map((p) => ({
            shareId: p.fileId,
            name: names.get(p.fileId) ?? null,
            score: p.score,
            lambdaTemporal: p.lambdaTemporal,
            lambdaRecency: p.lambdaRecency,
            selected: chosen.has(p.fileId),
            cached: cache.has(p.fileId, now),
        }));
        r.stats.ticks++;
        r.stats.lastTickAt = now;
        void publishStatus(now);
    } finally {
        r.stats.lastTickMs = Date.now() - t0;
        r.tickRunning = false;
    }
}

/** Retention for persisted events (called from the cleanup job). */
export async function runPredictionRetention(): Promise<void> {
    try {
        await pruneAccessEvents();
    } catch (e) {
        log.warn({ error: errMsg(e) }, 'access event retention failed');
    }
}

// ---------------------------------------------------------------------------
// Admin status
// ---------------------------------------------------------------------------

export function getPredictionStatus() {
    const r = rt();
    const now = Date.now();
    const cache = getStreamCache();
    return {
        enabled: predictionEnabled(),
        ready: r.ready,
        now,
        config: {
            windowMs: r.engine.cfg.windowMs,
            minScore: r.engine.cfg.minScore,
            maxPredictions: r.engine.cfg.maxPredictions,
            successorsK: r.engine.cfg.successorsK,
            intervalMs: prefetchIntervalMs(),
            prefetchMaxBytes: cache.opts.prefetchMaxBytes,
            cacheMaxBytes: cache.opts.maxBytes,
            concurrency: warmConcurrency(),
            tzOffsetMinutes: r.engine.model.cfg.tzOffsetMinutes,
        },
        model: {
            trackedFiles: r.engine.model.trackedFiles,
            trackedActors: r.engine.model.trackedActors,
            observedEvents: r.engine.model.observedEvents,
            rebuiltEvents: r.stats.rebuiltEvents,
            rebuildMs: r.stats.rebuildMs,
            rebuildError: r.stats.rebuildError,
        },
        metrics: r.engine.metrics.snapshot(now),
        cache: cache.stats(),
        prefetch: {
            ticks: r.stats.ticks,
            lastTickAt: r.stats.lastTickAt,
            lastTickMs: r.stats.lastTickMs,
            warmed: r.stats.warmed,
            warmedBytes: r.stats.warmedBytes,
            warmFailed: r.stats.warmFailed,
            warmSkipped: r.stats.warmSkipped,
            warmDroppedQueueFull: r.stats.warmDroppedQueueFull,
            lastWarmError: r.stats.lastWarmError,
            reactorReads: r.stats.reactorReads,
            reactorTouches: r.stats.reactorTouches,
            queue: r.warmQueue.length,
            active: r.warmActive,
        },
        events: accessEventStats(),
        topPredictions: r.top,
    };
}

// ---------------------------------------------------------------------------
// Cluster status (admin): per-instance snapshots in the shared KV, aggregated on read
// ---------------------------------------------------------------------------

function statusTtlMs(): number {
    return Math.max(prefetchIntervalMs(), 60_000) * 3;
}

async function publishStatus(now: number) {
    const kv = clusterKV();
    if (!kv) return;
    try {
        const ttl = statusTtlMs();
        const id = instanceId();
        const snap = { instance: id, at: now, metrics: rt().engine.metrics.snapshot(now), cache: getStreamCache().stats() };
        await kv.set(statusKey(id), JSON.stringify(snap), ttl);
        await kv.zAddCapped(STATUS_INSTANCES_KEY, id, now, now - ttl, MAX_STATUS_INSTANCES, ttl);
    } catch (e) {
        log.warn({ error: errMsg(e) }, 'status publish failed');
    }
}

type Rate = { numerator: number; denominator: number; rate: number | null };
const sumRates = (xs: Rate[]): Rate => {
    const n = xs.reduce((a, x) => a + x.numerator, 0);
    const d = xs.reduce((a, x) => a + x.denominator, 0);
    return { numerator: n, denominator: d, rate: d > 0 ? n / d : null };
};

/**
 * Local status plus, when REDIS_URL is set, every live instance's latest metrics snapshot and their sums
 * (precision/recall/hit-rate numerators and denominators add up; TTFB percentiles stay per instance).
 */
export async function getClusterPredictionStatus() {
    const local = getPredictionStatus();
    const kv = clusterKV();
    if (!kv) return { ...local, instance: instanceId(), cluster: null };
    await publishStatus(Date.now());
    const ids = await kv.zMembers(STATUS_INSTANCES_KEY, Date.now() - statusTtlMs());
    const snaps: { instance: string; at: number; metrics: MetricsSnapshot }[] = [];
    for (const id of ids) {
        const raw = await kv.get(statusKey(id));
        if (!raw) continue;
        try { snaps.push(JSON.parse(raw)); } catch { /* skip */ }
    }
    const ms = snaps.map((x) => x.metrics);
    return {
        ...local,
        instance: instanceId(),
        cluster: {
            instances: snaps,
            aggregate: {
                precision: {
                    temporal: sumRates(ms.map((m) => m.precision.temporal)),
                    sequential: sumRates(ms.map((m) => m.precision.sequential)),
                    intent: sumRates(ms.map((m) => m.precision.intent)),
                    all: sumRates(ms.map((m) => m.precision.all)),
                },
                recall: sumRates(ms.map((m) => m.recall)),
                hitRate: {
                    predicted: sumRates(ms.map((m) => m.hitRate.predicted)),
                    unpredicted: sumRates(ms.map((m) => m.hitRate.unpredicted)),
                    all: sumRates(ms.map((m) => m.hitRate.all)),
                },
                requests: ms.reduce((a, m) => a + m.requests, 0),
                openPredictions: ms.reduce((a, m) => a + m.openPredictions, 0),
            },
        },
    };
}
