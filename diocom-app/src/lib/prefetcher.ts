import { createHmac } from 'crypto';
import { getToken } from 'next-auth/jwt';
import { FileRepository, FileRecord } from '@/db/files';
import { getAppSecret, getClientIp } from '@/lib/security';
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
    return g.__diocomPrefetch;
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
                console.warn('[PREDICT] Could not rebuild model from access events:', r.stats.rebuildError);
            }
            for (const p of r.pending) model.observe(p.fileId, p.ts, p.actor);
            r.pending = [];
            r.engine.model = model;
            r.ready = true;
            r.stats.rebuildMs = Date.now() - t0;
            console.log(`[PREDICT] Model ready: ${model.trackedFiles} files from ${r.stats.rebuiltEvents} events in ${r.stats.rebuildMs} ms.`);
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
            .catch((e) => console.warn('[PREDICT] access hook failed:', e instanceof Error ? e.message : e));
    } catch (e) {
        console.warn('[PREDICT] access hook failed:', e instanceof Error ? e.message : e);
    }
}

function onObserved(fileId: string, ts: number, actor: string | null) {
    const r = rt();
    enqueueAccessEvent({ file_id: fileId, ts, actor: actor ?? '' });
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

/** Drops a deleted/expired file from the model, metadata memo and cache. */
export function forgetFile(shareId: string) {
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
        console.warn('[PREDICT] Access event retention failed:', e instanceof Error ? e.message : e);
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
