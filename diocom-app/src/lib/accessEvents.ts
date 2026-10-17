import db from '@/db';

/**
 * Persistent access events for the prediction model (NETWORK_SPEC §5): (file_id, ts, actor).
 * actor is "u:<user id>" or "a:<truncated HMAC(app secret, ip + ua)>" — raw IPs are never stored.
 *
 * Writes are fire-and-forget: events go into a bounded in-memory queue (oldest dropped when full) that is flushed
 * in batches (multi-row INSERT) off the request path. Retention: PREDICT_RETENTION_DAYS (default 30) plus a row cap
 * PREDICT_MAX_EVENTS (default 500 000), enforced by pruneAccessEvents() from the cleanup job.
 *
 * Queries are deliberately simple: the dev JSON store emulates exactly these statements (src/db/localStore.ts).
 * The table is owned by migrations/0001_initial.sql; ensureAccessEventsTable() is a harmless IF NOT EXISTS guard.
 */

export interface AccessEventRow {
    file_id: string;
    ts: number;
    actor: string;
}

const BATCH_SIZE = 200;
const FLUSH_DELAY_MS = 2_000;
const MAX_QUEUE = 10_000;
const DAY_MS = 86_400_000;

function envInt(name: string, fallback: number, min = 0): number {
    const n = parseInt(process.env[name] || '', 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
}

export function retentionMs(): number {
    return envInt('PREDICT_RETENTION_DAYS', 30, 1) * DAY_MS;
}

export function maxEvents(): number {
    return envInt('PREDICT_MAX_EVENTS', 500_000, 1000);
}

interface WriterState {
    queue: AccessEventRow[];
    timer: ReturnType<typeof setTimeout> | null;
    flushing: boolean;
    tableReady: Promise<void> | null;
    stats: {
        queued: number;
        written: number;
        dropped: number;
        writeErrors: number;
        lastError: string | null;
        lastPruneAt: number | null;
        lastPruneDeleted: number;
    };
    lastErrorLogAt: number;
}

const g = globalThis as typeof globalThis & { __diocomAccessEvents?: WriterState };

function state(): WriterState {
    if (!g.__diocomAccessEvents) {
        g.__diocomAccessEvents = {
            queue: [],
            timer: null,
            flushing: false,
            tableReady: null,
            stats: { queued: 0, written: 0, dropped: 0, writeErrors: 0, lastError: null, lastPruneAt: null, lastPruneDeleted: 0 },
            lastErrorLogAt: 0,
        };
    }
    return g.__diocomAccessEvents;
}

/** Creates the table on PostgreSQL if the schema init script hasn't been re-run (no-op for the JSON store). */
export function ensureAccessEventsTable(): Promise<void> {
    const s = state();
    if (!s.tableReady) {
        s.tableReady = db
            .query(
                'CREATE TABLE IF NOT EXISTS access_events (id BIGSERIAL PRIMARY KEY, file_id TEXT NOT NULL, ts BIGINT NOT NULL, actor TEXT NOT NULL); ' +
                'CREATE INDEX IF NOT EXISTS idx_access_events_ts ON access_events(ts);'
            )
            .then(() => undefined)
            .catch((e: unknown) => {
                s.tableReady = null; // retry later
                throw e;
            });
    }
    return s.tableReady;
}

function logError(s: WriterState, msg: string) {
    s.stats.lastError = msg;
    const now = Date.now();
    if (now - s.lastErrorLogAt > 60_000) {
        s.lastErrorLogAt = now;
        console.error(`[PREDICT] access event write failed: ${msg}`);
    }
}

async function flush(): Promise<void> {
    const s = state();
    s.timer = null;
    if (s.flushing) return;
    s.flushing = true;
    try {
        await ensureAccessEventsTable();
        while (s.queue.length > 0) {
            const batch = s.queue.splice(0, BATCH_SIZE);
            const values: string[] = [];
            const params: (string | number)[] = [];
            batch.forEach((e, i) => {
                values.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
                params.push(e.file_id, e.ts, e.actor);
            });
            try {
                await db.query(`INSERT INTO access_events (file_id, ts, actor) VALUES ${values.join(', ')}`, params);
                s.stats.written += batch.length;
            } catch (e) {
                // Dropped, not retried: the model already learned from these events in memory.
                s.stats.writeErrors++;
                logError(s, e instanceof Error ? e.message : String(e));
            }
        }
    } catch (e) {
        s.stats.writeErrors++;
        s.stats.dropped += s.queue.length;
        s.queue.length = 0;
        logError(s, e instanceof Error ? e.message : String(e));
    } finally {
        s.flushing = false;
        if (s.queue.length > 0 && !s.timer) schedule(FLUSH_DELAY_MS);
    }
}

function schedule(delay: number) {
    const s = state();
    if (s.timer) return;
    s.timer = setTimeout(() => { void flush(); }, delay);
    s.timer.unref?.();
}

/** Enqueues an event; never blocks or throws. */
export function enqueueAccessEvent(e: AccessEventRow): void {
    const s = state();
    s.queue.push(e);
    s.stats.queued++;
    if (s.queue.length > MAX_QUEUE) {
        const over = s.queue.length - MAX_QUEUE;
        s.queue.splice(0, over);
        s.stats.dropped += over;
    }
    schedule(s.queue.length >= BATCH_SIZE ? 0 : FLUSH_DELAY_MS);
}

/** Most recent events within retention, oldest first (for rebuilding the model on startup). */
export async function loadRecentAccessEvents(now = Date.now(), limit = maxEvents()): Promise<AccessEventRow[]> {
    await ensureAccessEventsTable();
    const res = await db.query(
        'SELECT file_id, ts, actor FROM access_events WHERE ts >= $1 ORDER BY ts DESC LIMIT $2',
        [now - retentionMs(), limit]
    );
    const rows: AccessEventRow[] = (res.rows as Record<string, unknown>[])
        .map((r) => ({ file_id: String(r.file_id), ts: Number(r.ts), actor: String(r.actor ?? '') }))
        .filter((r) => r.file_id && Number.isFinite(r.ts));
    return rows.reverse();
}

/** Deletes events older than the retention period, then the oldest beyond PREDICT_MAX_EVENTS. */
export async function pruneAccessEvents(now = Date.now()): Promise<number> {
    const s = state();
    await ensureAccessEventsTable();
    let deleted = 0;
    const r1 = await db.query('DELETE FROM access_events WHERE ts < $1', [now - retentionMs()]);
    deleted += Number(r1.rowCount) || 0;
    const nth = await db.query('SELECT ts FROM access_events ORDER BY ts DESC LIMIT 1 OFFSET $1', [maxEvents()]);
    if (nth.rows.length > 0) {
        const r2 = await db.query('DELETE FROM access_events WHERE ts < $1', [Number(nth.rows[0].ts)]);
        deleted += Number(r2.rowCount) || 0;
    }
    s.stats.lastPruneAt = now;
    s.stats.lastPruneDeleted = deleted;
    if (deleted > 0) console.log(`[PREDICT] Pruned ${deleted} access events.`);
    return deleted;
}

export function accessEventStats() {
    const s = state();
    return { ...s.stats, pending: s.queue.length, retentionDays: retentionMs() / DAY_MS, maxEvents: maxEvents() };
}
