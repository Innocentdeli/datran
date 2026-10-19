import db from './index';

/**
 * Runs `fn` inside one database transaction on a dedicated connection (BEGIN ... COMMIT, ROLLBACK on throw).
 * `fn` may call `rollback(value)` to roll back and still return a value (e.g. "insufficient balance").
 *
 * The dev JSON store has no real transactions (BEGIN/COMMIT/ROLLBACK are no-ops there), so callers order their
 * statements so that every early rollback happens before the first write.
 */

export interface TxClient {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>;
}

class RollbackSignal<T> {
    constructor(readonly value: T) {}
}

export async function withTransaction<T>(fn: (client: TxClient, rollback: <R extends T>(value: R) => never) => Promise<T>): Promise<T> {
    const client = await db.connect();
    const rollback = <R extends T>(value: R): never => {
        throw new RollbackSignal(value);
    };
    try {
        await client.query('BEGIN');
        const result = await fn(client as unknown as TxClient, rollback);
        await client.query('COMMIT');
        return result;
    } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        if (e instanceof RollbackSignal) return e.value as T;
        throw e;
    } finally {
        client.release();
    }
}
