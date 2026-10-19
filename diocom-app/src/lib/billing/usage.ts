import db from '@/db';
import type { TxClient } from '@/db/tx';
import { getKV, withLock, type KV } from '@/lib/kv';
import { createModuleLogger } from '../observability/logger';
import { recordEgressFlush, recordKvError } from '../observability/metrics';
import { usagePeriod } from './plans';

const log = createModuleLogger('usage');

/**
 * Usage accounting (PostgreSQL, migrations/0003):
 *  - user_usage.storage_bytes: size of a user's live files. Reserved atomically at finalize (refused when it would
 *    exceed the plan quota), released when a file is deleted or expires (src/db/files.ts FileRepository.delete).
 *  - usage_monthly: egress / uploads per subject and calendar month. Subject = user id, or `anon:<share_id>` for
 *    anonymous uploads (per-file quota).
 *
 * Egress batching: /api/stream never writes PostgreSQL per request. Each response adds its byte count to a hash in
 * the shared KV (Redis HINCRBY; field = "<subject>|<YYYY-MM>"); the leader (KV lock) drains the hash atomically and
 * applies the sums every BILLING_FLUSH_INTERVAL_MS (default 30 s). Quota checks read PostgreSQL + the pending KV
 * value, so they see bytes that were not flushed yet.
 */

export const EGRESS_PENDING_KEY = 'billing:egress:pending';
const PENDING_TTL_MS = 7 * 86_400_000;
export const EGRESS_FLUSH_LOCK = 'billing-egress-flush';

const num = (v: unknown) => Number(v ?? 0) || 0;
const field = (subject: string, period: string) => `${subject}|${period}`;

export function egressSubject(ownerId: string | null | undefined, shareId: string): string {
    return ownerId ? ownerId : `anon:${shareId}`;
}

// ---- storage ------------------------------------------------------------------------------------------------------

export async function getStorageUsage(userId: string): Promise<{ storageBytes: number; uploadsCount: number }> {
    const res = await db.query('SELECT storage_bytes, uploads_count FROM user_usage WHERE user_id = $1', [userId]);
    return { storageBytes: num(res.rows[0]?.storage_bytes), uploadsCount: num(res.rows[0]?.uploads_count) };
}

/**
 * Atomically adds `bytes` to the user's storage if the result stays within `quotaBytes` (null = unlimited).
 * Returns false (nothing changed) when the quota would be exceeded. Concurrent uploads cannot overshoot: the
 * conditional upsert is a single statement on one row.
 */
export async function reserveStorage(userId: string, bytes: number, quotaBytes: number | null): Promise<boolean> {
    const quota = quotaBytes === null ? Number.MAX_SAFE_INTEGER : quotaBytes;
    const res = await db.query(
        'INSERT INTO user_usage (user_id, storage_bytes, uploads_count, updated_at) SELECT $1::text, $2::bigint, 1, $4::bigint WHERE $2::bigint <= $3::bigint ON CONFLICT (user_id) DO UPDATE SET storage_bytes = user_usage.storage_bytes + EXCLUDED.storage_bytes, uploads_count = user_usage.uploads_count + 1, updated_at = EXCLUDED.updated_at WHERE user_usage.storage_bytes + EXCLUDED.storage_bytes <= $3::bigint RETURNING storage_bytes',
        [userId, Math.max(0, Math.floor(bytes)), quota, Date.now()],
    );
    return Number(res.rowCount) > 0;
}

export async function releaseStorage(userId: string, bytes: number): Promise<void> {
    await db.query('UPDATE user_usage SET storage_bytes = GREATEST(storage_bytes - $1, 0), updated_at = $2 WHERE user_id = $3', [
        Math.max(0, Math.floor(bytes)), Date.now(), userId,
    ]);
}

// ---- monthly counters ---------------------------------------------------------------------------------------------

export interface MonthlyUsage {
    egressBytes: number;
    creditedEgressBytes: number;
    uploadsCount: number;
}

export async function getMonthlyUsage(subject: string, period = usagePeriod()): Promise<MonthlyUsage> {
    const res = await db.query('SELECT egress_bytes, credited_egress_bytes, uploads_count FROM usage_monthly WHERE subject = $1 AND period = $2', [subject, period]);
    const r = res.rows[0];
    return { egressBytes: num(r?.egress_bytes), creditedEgressBytes: num(r?.credited_egress_bytes), uploadsCount: num(r?.uploads_count) };
}

export async function incrementMonthlyUploads(subject: string, period = usagePeriod()): Promise<void> {
    await db.query(
        'INSERT INTO usage_monthly (subject, period, uploads_count, updated_at) VALUES ($1, $2, 1, $3) ON CONFLICT (subject, period) DO UPDATE SET uploads_count = usage_monthly.uploads_count + 1, updated_at = EXCLUDED.updated_at',
        [subject, period, Date.now()],
    );
}

/** Egress paid with credits (excluded from the quota). Runs inside the credit debit transaction. */
export async function addCreditedEgress(client: TxClient, subject: string, bytes: number, period = usagePeriod()): Promise<void> {
    await client.query(
        'INSERT INTO usage_monthly (subject, period, credited_egress_bytes, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (subject, period) DO UPDATE SET credited_egress_bytes = usage_monthly.credited_egress_bytes + EXCLUDED.credited_egress_bytes, updated_at = EXCLUDED.updated_at',
        [subject, period, Math.floor(bytes), Date.now()],
    );
}

// ---- egress batching ----------------------------------------------------------------------------------------------

/** Adds (or, for a correction, subtracts) served bytes to the pending batch in the shared KV. Never throws. */
export async function recordEgressBytes(subject: string, delta: number, period = usagePeriod(), kv: KV = getKV()): Promise<void> {
    const d = Math.trunc(delta);
    if (!d) return;
    try {
        await kv.hIncrBy(EGRESS_PENDING_KEY, field(subject, period), d, PENDING_TTL_MS);
    } catch (e) {
        recordKvError('hIncrBy');
        log.error({ err: e }, 'could not record egress bytes');
    }
}

export async function pendingEgress(subject: string, period = usagePeriod(), kv: KV = getKV()): Promise<number> {
    try {
        return await kv.hGet(EGRESS_PENDING_KEY, field(subject, period));
    } catch (e) {
        recordKvError('hGet');
        log.warn({ err: e }, 'could not read pending egress');
        return 0;
    }
}

/** Egress counted against the quota this month: served (flushed + pending) minus the part paid with credits. */
export async function billableEgress(subject: string, period = usagePeriod(), kv: KV = getKV()): Promise<{ served: number; credited: number; billable: number }> {
    const [m, pending] = await Promise.all([getMonthlyUsage(subject, period), pendingEgress(subject, period, kv)]);
    const served = Math.max(0, m.egressBytes + pending);
    return { served, credited: m.creditedEgressBytes, billable: Math.max(0, served - m.creditedEgressBytes) };
}

async function applyEgress(subject: string, period: string, bytes: number): Promise<void> {
    await db.query(
        'INSERT INTO usage_monthly (subject, period, egress_bytes, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (subject, period) DO UPDATE SET egress_bytes = GREATEST(usage_monthly.egress_bytes + EXCLUDED.egress_bytes, 0), updated_at = EXCLUDED.updated_at',
        [subject, period, bytes, Date.now()],
    );
}

/**
 * Drains the pending egress hash and applies it to usage_monthly (one upsert per subject+month, however many
 * requests). Leader-only via the KV lock; rows that fail to apply are put back into the batch.
 * Returns the number of rows applied, or null when another instance holds the lock.
 */
export async function flushEgress(kv: KV = getKV()): Promise<number | null> {
    try {
        const out = await withLock(EGRESS_FLUSH_LOCK, 60_000, async () => {
            const drained = await kv.hDrain(EGRESS_PENDING_KEY);
            let applied = 0;
            for (const [f, bytes] of Object.entries(drained)) {
                if (!bytes) continue;
                const sep = f.lastIndexOf('|');
                const subject = f.slice(0, sep);
                const period = f.slice(sep + 1);
                try {
                    await applyEgress(subject, period, bytes);
                    applied++;
                } catch (e) {
                    log.error({ err: e, period }, 'egress flush failed for a row; re-queued');
                    await kv.hIncrBy(EGRESS_PENDING_KEY, f, bytes, PENDING_TTL_MS).catch(() => undefined);
                }
            }
            return applied;
        }, kv);
        if (!out.acquired) {
            recordEgressFlush('skipped');
            return null;
        }
        recordEgressFlush('ok');
        return out.result;
    } catch (e) {
        recordEgressFlush('error');
        log.error({ err: e }, 'egress flush failed');
        return 0;
    }
}

export function egressFlushIntervalMs(): number {
    const v = parseInt(process.env.BILLING_FLUSH_INTERVAL_MS || '', 10);
    return Number.isFinite(v) && v >= 0 ? v : 30_000;
}
