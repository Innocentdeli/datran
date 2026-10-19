import { randomUUID } from 'crypto';
import db from '@/db';
import { withTransaction, type TxClient } from '@/db/tx';
import { createModuleLogger } from '../observability/logger';
import { recordCreditTransaction } from '../observability/metrics';

const log = createModuleLogger('credits');

/**
 * Credit ledger. Every balance change is ONE transaction that writes a credit_ledger row with a unique
 * idempotency key and updates user_credits:
 *  - debits use `UPDATE ... WHERE balance >= amount`: under concurrency PostgreSQL re-checks the predicate after the
 *    row lock is granted, so the balance can never go negative (plus a CHECK (balance >= 0) as a backstop);
 *  - a repeated idempotency key (retried webhook / request) is a no-op that returns the original outcome.
 * Amounts are signed in the ledger (grants > 0, debits < 0) and rounded to 6 decimals (NUMERIC(20,6)).
 */

export type CreditType = 'purchase' | 'earn' | 'spend' | 'egress' | 'refund_clawback' | 'grant' | 'adjustment';

export type CreditResult =
    | { ok: true; balance: number; entryId: string | null; replay: boolean; amount: number }
    | { ok: false; reason: 'insufficient'; balance: number };

export interface CreditOptions {
    type: CreditType;
    reason?: string | null;
    /** Unique per logical operation (e.g. `stripe:checkout:<session id>`). Defaults to a random key (no dedup). */
    idempotencyKey?: string;
    /** Extra statements executed in the same transaction after a successful debit/grant. */
    extra?: (client: TxClient) => Promise<void>;
}

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
const num = (v: unknown) => Number(v ?? 0) || 0;

function validAmount(amount: number): number {
    const a = round6(amount);
    if (!Number.isFinite(a) || a <= 0) throw new Error(`invalid credit amount ${amount}`);
    return a;
}

async function replayOf(client: TxClient, key: string): Promise<CreditResult | null> {
    const prev = await client.query('SELECT id, amount, balance_after FROM credit_ledger WHERE idempotency_key = $1', [key]);
    const row = prev.rows[0];
    if (!row) return null;
    return { ok: true, balance: num(row.balance_after), entryId: String(row.id), replay: true, amount: Math.abs(num(row.amount)) };
}

/** Adds credits (purchase, reward, manual grant). Idempotent per key. */
export async function grantCredits(userId: string, amount: number, opts: CreditOptions): Promise<CreditResult> {
    const value = validAmount(amount);
    const key = opts.idempotencyKey ?? `grant:${randomUUID()}`;
    const now = Date.now();
    try {
        const result = await withTransaction<CreditResult>(async (client, rollback) => {
            const id = randomUUID();
            // Ledger first: a duplicate key stops here before anything else is written.
            const ins = await client.query(
                'INSERT INTO credit_ledger (id, user_id, amount, type, reason, timestamp, idempotency_key) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id',
                [id, userId, value, opts.type, opts.reason ?? null, now, key],
            );
            if (!ins.rowCount) {
                const replay = await replayOf(client, key);
                return rollback(replay ?? { ok: true, balance: await getBalance(userId), entryId: null, replay: true, amount: value });
            }
            const upd = await client.query(
                'INSERT INTO user_credits (user_id, balance, total_earned, total_spent, last_updated) VALUES ($1, $2, $3, 0, $4) ON CONFLICT (user_id) DO UPDATE SET balance = user_credits.balance + EXCLUDED.balance, total_earned = user_credits.total_earned + EXCLUDED.total_earned, last_updated = EXCLUDED.last_updated RETURNING balance',
                [userId, value, value, now],
            );
            const balance = num(upd.rows[0]?.balance);
            await client.query('UPDATE credit_ledger SET balance_after = $1 WHERE id = $2', [balance, id]);
            await opts.extra?.(client);
            return { ok: true, balance, entryId: id, replay: false, amount: value };
        });
        recordCreditTransaction(opts.type, result.ok && result.replay ? 'replay' : 'ok');
        if (result.ok && !result.replay) log.info({ userId, amount: value, type: opts.type }, 'credits granted');
        return result;
    } catch (e) {
        recordCreditTransaction(opts.type, 'error');
        throw e;
    }
}

/**
 * Removes exactly `amount` credits or nothing: { ok: false, reason: 'insufficient' } when the balance is too low.
 * Idempotent per key (a replay returns the original debit).
 */
export async function debitCredits(userId: string, amount: number, opts: CreditOptions): Promise<CreditResult> {
    const value = validAmount(amount);
    const key = opts.idempotencyKey ?? `debit:${randomUUID()}`;
    const now = Date.now();
    try {
        const result = await withTransaction<CreditResult>(async (client, rollback) => {
            const replay = await replayOf(client, key);
            if (replay) return rollback(replay);
            // Conditional decrement first (row lock serialises concurrent debits of one user; the WHERE is re-checked
            // after the lock is granted, so concurrent debits can never take the balance below zero).
            const upd = await client.query(
                'UPDATE user_credits SET balance = balance - $1, total_spent = total_spent + $1, last_updated = $2 WHERE user_id = $3 AND balance >= $1 RETURNING balance',
                [value, now, userId],
            );
            if (!upd.rowCount) return rollback({ ok: false, reason: 'insufficient', balance: -1 });
            const balance = num(upd.rows[0].balance);
            const id = randomUUID();
            const ins = await client.query(
                'INSERT INTO credit_ledger (id, user_id, amount, type, reason, timestamp, idempotency_key, balance_after) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id',
                [id, userId, -value, opts.type, opts.reason ?? null, now, key, balance],
            );
            // A concurrent request with the same key won the race: undo our decrement, report the original.
            if (!ins.rowCount) return rollback({ ok: true, balance: -1, entryId: null, replay: true, amount: value });
            await opts.extra?.(client);
            return { ok: true, balance, entryId: id, replay: false, amount: value };
        });
        if (result.balance === -1) result.balance = await getBalance(userId);
        recordCreditTransaction(opts.type, !result.ok ? 'insufficient' : result.replay ? 'replay' : 'ok');
        return result;
    } catch (e) {
        recordCreditTransaction(opts.type, 'error');
        throw e;
    }
}

/**
 * Removes up to `maxAmount` credits (refund clawback: only credits that were not spent yet can be taken back).
 * Returns the amount actually removed (0 when the balance is empty). Idempotent per key.
 */
export async function clawbackCredits(userId: string, maxAmount: number, opts: Omit<CreditOptions, 'type'> & { idempotencyKey: string }): Promise<{ removed: number; balance: number; replay: boolean }> {
    const target = round6(maxAmount);
    const now = Date.now();
    const result = await withTransaction<{ removed: number; balance: number; replay: boolean }>(async (client, rollback) => {
        const replay = await replayOf(client, opts.idempotencyKey);
        if (replay?.ok) return rollback({ removed: replay.amount, balance: replay.balance, replay: true });
        const cur = await client.query('SELECT balance FROM user_credits WHERE user_id = $1 FOR UPDATE', [userId]);
        const available = num(cur.rows[0]?.balance);
        const removed = round6(Math.max(0, Math.min(available, target)));
        let balance = available;
        if (removed > 0) {
            const upd = await client.query(
                'UPDATE user_credits SET balance = balance - $1, total_spent = total_spent + $1, last_updated = $2 WHERE user_id = $3 AND balance >= $1 RETURNING balance',
                [removed, now, userId],
            );
            if (!upd.rowCount) throw new Error('clawback: balance changed concurrently');
            balance = num(upd.rows[0].balance);
        }
        // Recorded even when nothing could be removed, so the refund is visible in the history and not re-processed.
        await client.query(
            'INSERT INTO credit_ledger (id, user_id, amount, type, reason, timestamp, idempotency_key, balance_after) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id',
            [randomUUID(), userId, -removed, 'refund_clawback', opts.reason ?? null, now, opts.idempotencyKey, balance],
        );
        await opts.extra?.(client);
        return { removed, balance, replay: false };
    });
    recordCreditTransaction('refund_clawback', result.replay ? 'replay' : 'ok');
    return result;
}

export async function getBalance(userId: string): Promise<number> {
    const res = await db.query('SELECT balance FROM user_credits WHERE user_id = $1', [userId]);
    return num(res.rows[0]?.balance);
}

export interface LedgerEntry {
    id: string;
    amount: number;
    type: string;
    reason: string | null;
    timestamp: number;
    balanceAfter: number | null;
}

export async function listLedger(userId: string, limit = 50): Promise<LedgerEntry[]> {
    const res = await db.query(
        'SELECT id, amount, type, reason, timestamp, balance_after FROM credit_ledger WHERE user_id = $1 ORDER BY timestamp DESC LIMIT $2',
        [userId, Math.max(1, Math.min(500, Math.floor(limit)))],
    );
    return res.rows.map((r) => {
        // Legacy rows (before 0003) stored debits as positive amounts with type 'spend'.
        const raw = num(r.amount);
        const amount = r.type === 'spend' && raw > 0 ? -raw : raw;
        return {
            id: String(r.id),
            amount,
            type: String(r.type),
            reason: (r.reason as string | null) ?? null,
            timestamp: num(r.timestamp),
            balanceAfter: r.balance_after === null || r.balance_after === undefined ? null : num(r.balance_after),
        };
    });
}
