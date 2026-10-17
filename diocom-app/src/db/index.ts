import { Pool, type PoolClient } from 'pg';
import { LocalPersistentStore, resolveLocalDbPath, type QueryResult } from './localStore';
import { runMigrations, migrationStatus } from './migrate';

type LocalClient = { query: (text: string, params?: unknown[]) => Promise<QueryResult>; release: () => void };
type Backend = 'postgres' | 'local';

export class DatabaseUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DatabaseUnavailableError';
    }
}

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Backend selection happens ONCE per process (first query, or ensureDatabaseReady() from instrumentation):
 *  - production: PostgreSQL is mandatory. DATABASE_URL unset, Postgres unreachable, migration integrity errors or
 *    pending migrations (without DB_AUTO_MIGRATE=true) are fatal. There is no JSON fallback in production.
 *  - development/test: DATABASE_URL unset or unreachable -> the dev-only JSON emulator (src/db/localStore.ts).
 *  - Postgres reachable: DB_AUTO_MIGRATE=true applies pending migrations (advisory-locked, safe with several
 *    instances); otherwise the schema state is only checked (`npm run db:migrate` applies it).
 *  Later query errors are always thrown to the caller (never re-routed to another backend).
 */
class HybridDatabasePool {
    private pgPool: Pool | null = null;
    private localStore: LocalPersistentStore | null = null;
    private backendPromise: Promise<Backend> | null = null;
    private readonly connectionString = process.env.DATABASE_URL;

    constructor() {
        if (this.connectionString) {
            this.pgPool = new Pool({
                connectionString: this.connectionString,
                max: parseInt(process.env.DB_POOL_MAX || '', 10) || 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 5000,
                application_name: 'diocom-app',
            });
            // Prevent idle-client errors from crashing the process
            this.pgPool.on('error', (err) => {
                console.error('[DB] PostgreSQL idle client error:', err.message);
            });
        }
    }

    private getLocalStore(): LocalPersistentStore {
        if (!this.localStore) this.localStore = new LocalPersistentStore();
        return this.localStore;
    }

    private async prepareSchema(): Promise<void> {
        if (process.env.DB_AUTO_MIGRATE === 'true') {
            await runMigrations({ connectionString: this.connectionString });
            return;
        }
        const s = await migrationStatus({ connectionString: this.connectionString });
        if (s.errors.length) {
            throw new DatabaseUnavailableError(`Database migration state is invalid:\n  - ${s.errors.join('\n  - ')}`);
        }
        if (s.pending.length) {
            const msg = `${s.pending.length} pending database migration(s) (${s.pending.map((p) => p.filename).join(', ')}). ` +
                'Run `npm run db:migrate` (or set DB_AUTO_MIGRATE=true).';
            if (isProduction()) throw new DatabaseUnavailableError(msg);
            console.warn(`[DB] WARNING: ${msg}`);
        }
    }

    private async selectBackend(): Promise<Backend> {
        if (isProduction() && process.env.DB_ALLOW_LOCAL_FALLBACK) {
            console.error('[DB] DB_ALLOW_LOCAL_FALLBACK is no longer supported and is ignored: production always requires PostgreSQL.');
        }
        if (!this.pgPool) {
            if (isProduction()) {
                throw new DatabaseUnavailableError('DATABASE_URL is not set. PostgreSQL is required in production (the JSON store is dev-only).');
            }
            console.info(`[DB] Active backend: LOCAL JSON store (${resolveLocalDbPath()}) — DATABASE_URL not set. Development only.`);
            return 'local';
        }
        try {
            await this.pgPool.query('SELECT 1');
        } catch (err) {
            if (isProduction()) {
                throw new DatabaseUnavailableError(`PostgreSQL is unreachable: ${(err as Error).message}`);
            }
            console.error(
                `[DB] PostgreSQL unreachable (${(err as Error).message}). ` +
                `Active backend: LOCAL JSON store (${resolveLocalDbPath()}). Development only.`
            );
            await this.pgPool.end().catch(() => { });
            this.pgPool = null;
            return 'local';
        }
        await this.prepareSchema();
        console.info('[DB] Active backend: PostgreSQL.');
        return 'postgres';
    }

    resolveBackend(): Promise<Backend> {
        if (!this.backendPromise) {
            this.backendPromise = this.selectBackend().catch((err) => {
                console.error('[DB] FATAL:', (err as Error).message);
                // Allow a retry on the next request rather than caching the failure forever
                this.backendPromise = null;
                throw err instanceof DatabaseUnavailableError ? err : new DatabaseUnavailableError((err as Error).message);
            });
        }
        return this.backendPromise;
    }

    public async query(text: string, params?: unknown[]): Promise<QueryResult> {
        const backend = await this.resolveBackend();
        if (backend === 'postgres' && this.pgPool) {
            // Errors (constraint violations, syntax, transient network) propagate to the caller
            const r = await this.pgPool.query(text, params);
            return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        }
        return this.getLocalStore().query(text, params);
    }

    public async connect(): Promise<PoolClient | LocalClient> {
        const backend = await this.resolveBackend();
        if (backend === 'postgres' && this.pgPool) {
            return this.pgPool.connect();
        }
        return this.getLocalStore().connect();
    }

    public async end(): Promise<void> {
        await this.pgPool?.end();
        this.pgPool = null;
        this.backendPromise = null;
    }
}

if (!global.diocomHybridPool) {
    global.diocomHybridPool = new HybridDatabasePool() as unknown as Pool;
}
const pool = global.diocomHybridPool;

/**
 * Selects the backend and checks/applies migrations now instead of on the first query. Called from
 * src/instrumentation.ts so a production server with no usable PostgreSQL refuses to start.
 */
export async function ensureDatabaseReady(): Promise<'postgres' | 'local'> {
    return (pool as unknown as HybridDatabasePool).resolveBackend();
}

export default pool as Pool;

declare global {
    var diocomHybridPool: Pool | undefined;
}
