/**
 * Versioned SQL migrations for PostgreSQL (dependency-free apart from `pg`).
 *
 *  - Files: <dir>/NNNN_snake_name.sql (default dir: ./migrations relative to the process cwd = diocom-app/,
 *    override with DB_MIGRATIONS_DIR). Applied in version order, each in its own transaction together with its
 *    schema_migrations row, so a failing migration leaves nothing behind. A file whose first line is
 *    `-- migrate:no-transaction` runs outside a transaction (e.g. CREATE INDEX CONCURRENTLY).
 *  - Integrity: the SHA-256 of every applied file (CRLF/BOM-normalised, so git line-ending conversion does not
 *    matter) is stored; if an applied file changed, disappeared, or a new file sorts before the latest applied
 *    version, nothing runs and an error is thrown. Fix by adding a new migration, never by editing an old one.
 *  - Concurrency: a session-level advisory lock (MIGRATION_LOCK_KEY) serialises migrators across app instances;
 *    others wait up to lockTimeoutMs, then re-read the state (usually: nothing left to do).
 *  - Baseline: a database created by the legacy initializeSchema() (tables exist, no schema_migrations rows) is
 *    verified against LEGACY_BASELINE and marked as version 1 instead of failing on CREATE TABLE. Columns/tables
 *    the legacy code added lazily (reactor_*, access_events) are created first; anything else missing is an error.
 *
 * Kept free of path aliases and TS-only runtime syntax: scripts/db.mjs loads it with Node's type stripping.
 */
import pg from 'pg';
import type { ClientBase } from 'pg';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MIGRATIONS_TABLE = 'schema_migrations';
/** pg_advisory_lock key ("dicom" as ASCII bytes). Shared by every instance of the app. */
export const MIGRATION_LOCK_KEY = '431214522733';
const NO_TX_DIRECTIVE = /^\s*--\s*migrate:no-transaction\b/i;
const FILE_RE = /^(\d{4,})_([a-z0-9_]+)\.sql$/;

export interface Migration {
    version: number;
    name: string;
    filename: string;
    sql: string;
    checksum: string;
    transactional: boolean;
}

export interface AppliedMigration {
    version: number;
    name: string;
    checksum: string;
    applied_at: Date | string;
    baseline: boolean;
}

export class MigrationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MigrationError';
    }
}

export type Logger = (msg: string) => void;

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (unit-tested without a database)
// ---------------------------------------------------------------------------------------------------------------

/** SHA-256 hex of the migration text with BOM stripped and CRLF/CR normalised to LF. */
export function checksumOf(sql: string): string {
    const normalised = sql.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    return createHash('sha256').update(normalised, 'utf8').digest('hex');
}

export function parseMigrationFilename(filename: string): { version: number; name: string } | null {
    const m = FILE_RE.exec(filename);
    if (!m) return null;
    return { version: parseInt(m[1], 10), name: m[2] };
}

export function defaultMigrationsDir(): string {
    return path.resolve(process.cwd(), process.env.DB_MIGRATIONS_DIR || 'migrations');
}

/** Reads and validates the migration files (sorted by version). Any *.sql with a bad name is an error. */
export function loadMigrations(dir: string = defaultMigrationsDir()): Migration[] {
    if (!fs.existsSync(dir)) throw new MigrationError(`Migrations directory not found: ${dir}`);
    const out: Migration[] = [];
    const seen = new Map<number, string>();
    for (const filename of fs.readdirSync(dir).sort()) {
        if (!filename.toLowerCase().endsWith('.sql')) continue;
        const parsed = parseMigrationFilename(filename);
        if (!parsed) throw new MigrationError(`Bad migration filename "${filename}" (expected NNNN_snake_name.sql)`);
        const dup = seen.get(parsed.version);
        if (dup) throw new MigrationError(`Duplicate migration version ${parsed.version}: ${dup} and ${filename}`);
        seen.set(parsed.version, filename);
        const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
        out.push({
            version: parsed.version,
            name: parsed.name,
            filename,
            sql,
            checksum: checksumOf(sql),
            transactional: !NO_TX_DIRECTIVE.test(sql.replace(/^﻿/, '')),
        });
    }
    return out.sort((a, b) => a.version - b.version);
}

export interface MigrationPlan {
    pending: Migration[];
    /** Integrity problems; when non-empty nothing may be applied. */
    errors: string[];
}

/** Compares files with the applied rows: checksum drift, vanished files, out-of-order new files. */
export function planMigrations(files: Migration[], applied: AppliedMigration[]): MigrationPlan {
    const errors: string[] = [];
    const byVersion = new Map(files.map((f) => [f.version, f]));
    const appliedVersions = new Set<number>();
    let maxApplied = 0;
    for (const row of applied) {
        const v = Number(row.version);
        appliedVersions.add(v);
        maxApplied = Math.max(maxApplied, v);
        const file = byVersion.get(v);
        if (!file) {
            errors.push(`Migration ${v} (${row.name}) is applied in the database but its file is missing — is this an older build than the database?`);
        } else if (file.checksum !== row.checksum) {
            errors.push(`Migration ${file.filename} was modified after it was applied (checksum ${row.checksum.slice(0, 12)}… in DB, ${file.checksum.slice(0, 12)}… on disk). Revert the edit and add a new migration instead.`);
        }
    }
    const pending = files.filter((f) => !appliedVersions.has(f.version));
    for (const f of pending) {
        if (f.version < maxApplied) {
            errors.push(`Migration ${f.filename} is older than the latest applied version ${maxApplied} but was never applied (out of order). Renumber it above ${maxApplied}.`);
        }
    }
    return { pending, errors };
}

/** Tables/columns a legacy initializeSchema() database must have to be baselined at version 1 (= 0001_initial.sql). */
export const LEGACY_BASELINE: { version: number; tables: Record<string, string[]> } = {
    version: 1,
    tables: {
        users: ['id', 'name', 'email', 'password_hash', 'image', 'provider', 'role', 'current_challenge', 'username', 'created_at'],
        files: ['id', 'user_id', 'share_id', 'original_name', 'sanitized_name', 'storage_path', 'thumbnail_path', 'password_hash',
            'is_external', 'file_size', 'mime_type', 'created_at', 'expires_at', 'downloads', 'last_accessed_at', 'compression_ratio',
            'compression_speed', 'tags', 'summary', 'is_encrypted', 'encryption_iv', 'similarity_token', 'reactor_class', 'reactor_recipe'],
        analytics: ['id', 'file_id', 'event_type', 'timestamp', 'ip_address', 'user_agent'],
        chunks: ['id', 'original_size', 'hash'],
        variants: ['id', 'chunk_id', 'algorithm', 'settings', 'quality', 'fitness', 'data'],
        swarm_nodes: ['id', 'region', 'ip_address', 'last_pulse', 'status'],
        webauthn_credentials: ['id', 'user_id', 'public_key', 'counter', 'device_type', 'backed_up', 'transports'],
        audit_logs: ['id', 'user_id', 'action', 'resource', 'details', 'ip_address', 'timestamp', 'previous_hash', 'hash'],
        user_credits: ['user_id', 'balance', 'total_earned', 'total_spent', 'last_updated'],
        credit_ledger: ['id', 'user_id', 'amount', 'type', 'reason', 'timestamp'],
        inboxes: ['id', 'sender_id', 'recipient_id', 'file_id', 'status', 'message', 'created_at'],
        spaces: ['id', 'owner_id', 'name', 'slug', 'description', 'is_public', 'created_at', 'expires_at'],
        space_members: ['space_id', 'user_id', 'role', 'joined_at'],
        space_files: ['space_id', 'file_id', 'uploaded_by', 'uploaded_at'],
        lobby_sessions: ['id', 'code', 'creator_id', 'joiner_id', 'status', 'created_at', 'expires_at'],
        qr_sessions: ['id', 'creator_id', 'status', 'file_ids', 'created_at', 'expires_at'],
        access_events: ['id', 'file_id', 'ts', 'actor'],
    },
};

/**
 * Things older initializeSchema() versions added lazily/idempotently; the baseline creates them when absent.
 * Everything here mirrors 0001_initial.sql exactly.
 */
const BASELINE_REPAIRS: { table: string; columns: string[] | '*'; sql: string }[] = [
    { table: 'files', columns: ['reactor_class', 'reactor_recipe'],
        sql: 'ALTER TABLE files ADD COLUMN IF NOT EXISTS reactor_class TEXT, ADD COLUMN IF NOT EXISTS reactor_recipe TEXT' },
    { table: 'access_events', columns: '*',
        sql: 'CREATE TABLE IF NOT EXISTS access_events (id BIGSERIAL PRIMARY KEY, file_id TEXT NOT NULL, ts BIGINT NOT NULL, actor TEXT NOT NULL)' },
];
/** Legacy indexes from 0001, (re)created if a hand-managed database lacks them. */
const BASELINE_INDEXES = [
    'CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at)',
    'CREATE INDEX IF NOT EXISTS idx_inboxes_recipient ON inboxes(recipient_id)',
    'CREATE INDEX IF NOT EXISTS idx_access_events_ts ON access_events(ts)',
];

export interface SchemaDiff {
    missingTables: string[];
    /** "table.column" */
    missingColumns: string[];
}

export function diffSchema(actual: Map<string, Set<string>>, expected: Record<string, string[]> = LEGACY_BASELINE.tables): SchemaDiff {
    const missingTables: string[] = [];
    const missingColumns: string[] = [];
    for (const [table, cols] of Object.entries(expected)) {
        const have = actual.get(table);
        if (!have) { missingTables.push(table); continue; }
        for (const c of cols) if (!have.has(c)) missingColumns.push(`${table}.${c}`);
    }
    return { missingTables, missingColumns };
}

/** Splits a diff into what the baseline can create (repairs) and what blocks it. */
export function classifyBaselineDiff(diff: SchemaDiff): { repairs: string[]; blocking: string[] } {
    const repairs = new Set<string>();
    const blocking: string[] = [];
    for (const t of diff.missingTables) {
        const r = BASELINE_REPAIRS.find((x) => x.table === t && x.columns === '*');
        if (r) repairs.add(r.sql); else blocking.push(`table ${t}`);
    }
    for (const tc of diff.missingColumns) {
        const [t, c] = tc.split('.');
        const r = BASELINE_REPAIRS.find((x) => x.table === t && Array.isArray(x.columns) && x.columns.includes(c));
        if (r) repairs.add(r.sql); else blocking.push(`column ${tc}`);
    }
    return { repairs: [...repairs], blocking };
}

// ---------------------------------------------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------------------------------------------

export interface LockOptions {
    timeoutMs?: number;
    pollMs?: number;
}

/** Session-level advisory lock; polls pg_try_advisory_lock so a stuck migrator yields a clear timeout error. */
export async function acquireMigrationLock(client: ClientBase, opts: LockOptions = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? (parseInt(process.env.DB_MIGRATE_LOCK_TIMEOUT_MS || '', 10) || 120_000);
    const pollMs = opts.pollMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const r = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS ok', [MIGRATION_LOCK_KEY]);
        if (r.rows[0]?.ok) return;
        if (Date.now() >= deadline) {
            throw new MigrationError(`Timed out after ${timeoutMs} ms waiting for the migration lock (another instance is migrating, or a migrator is stuck — see pg_locks where objid = ${MIGRATION_LOCK_KEY} % 2^32).`);
        }
        await new Promise((r2) => setTimeout(r2, pollMs));
    }
}

export async function releaseMigrationLock(client: ClientBase): Promise<void> {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]);
}

async function tableExists(client: ClientBase, table: string): Promise<boolean> {
    const r = await client.query('SELECT to_regclass($1) IS NOT NULL AS ok', [table]);
    return !!r.rows[0]?.ok;
}

async function ensureMigrationsTable(client: ClientBase): Promise<void> {
    await client.query(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
            version INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            checksum TEXT NOT NULL,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            execution_ms INTEGER NOT NULL DEFAULT 0,
            baseline BOOLEAN NOT NULL DEFAULT false
        )`);
}

export async function readApplied(client: ClientBase): Promise<AppliedMigration[]> {
    if (!(await tableExists(client, MIGRATIONS_TABLE))) return [];
    const r = await client.query(`SELECT version, name, checksum, applied_at, baseline FROM ${MIGRATIONS_TABLE} ORDER BY version`);
    return r.rows.map((row) => ({ ...row, version: Number(row.version) }));
}

export async function readSchemaColumns(client: ClientBase): Promise<Map<string, Set<string>>> {
    const r = await client.query(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`
    );
    const m = new Map<string, Set<string>>();
    for (const row of r.rows) {
        const t = String(row.table_name);
        if (!m.has(t)) m.set(t, new Set());
        m.get(t)!.add(String(row.column_name));
    }
    return m;
}

/** True when the app's tables exist but nothing was ever recorded in schema_migrations. */
async function isLegacyDatabase(client: ClientBase, applied: AppliedMigration[]): Promise<boolean> {
    if (applied.length > 0) return false;
    return (await tableExists(client, 'users')) || (await tableExists(client, 'files'));
}

async function baseline(client: ClientBase, migration: Migration, log: Logger): Promise<void> {
    const diff = diffSchema(await readSchemaColumns(client));
    const { repairs, blocking } = classifyBaselineDiff(diff);
    if (blocking.length) {
        throw new MigrationError(
            `Existing database is not a recognised legacy schema, refusing to baseline it at ${migration.filename}. Missing: ${blocking.join(', ')}. ` +
            'Point DATABASE_URL at an empty database, or bring the schema up to 0001_initial.sql by hand first.'
        );
    }
    await client.query('BEGIN');
    try {
        for (const sql of repairs) {
            log(`[migrate] baseline repair: ${sql}`);
            await client.query(sql);
        }
        for (const sql of BASELINE_INDEXES) await client.query(sql);
        await client.query(
            `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, execution_ms, baseline) VALUES ($1, $2, $3, 0, true)`,
            [migration.version, migration.name, migration.checksum]
        );
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
    }
    log(`[migrate] Baselined existing legacy schema at ${migration.filename} (verified ${Object.keys(LEGACY_BASELINE.tables).length} tables).`);
}

async function applyOne(client: ClientBase, m: Migration, log: Logger): Promise<void> {
    const started = Date.now();
    const record = (ms: number) => client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, execution_ms, baseline) VALUES ($1, $2, $3, $4, false)`,
        [m.version, m.name, m.checksum, ms]
    );
    if (!m.transactional) {
        await client.query(m.sql);
        await record(Date.now() - started);
    } else {
        await client.query('BEGIN');
        try {
            await client.query(m.sql); // no params -> simple protocol, multiple statements allowed
            await record(Date.now() - started);
            await client.query('COMMIT');
        } catch (e) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw new MigrationError(`Migration ${m.filename} failed and was rolled back: ${(e as Error).message}`);
        }
    }
    log(`[migrate] Applied ${m.filename} (${Date.now() - started} ms)`);
}

export interface RunOptions {
    /** Defaults to DATABASE_URL. Ignored when `client` is given. */
    connectionString?: string;
    /** An already-connected client (kept open). Its session holds the advisory lock while migrating. */
    client?: ClientBase;
    dir?: string;
    lock?: LockOptions;
    log?: Logger;
    /** Hook for tests: runs after the lock is taken, before anything is read. */
    afterLock?: () => Promise<void>;
}

export interface RunResult {
    applied: string[];
    baselined: string | null;
    version: number;
}

async function withClient<T>(opts: RunOptions, fn: (c: ClientBase) => Promise<T>): Promise<T> {
    if (opts.client) return fn(opts.client);
    const connectionString = opts.connectionString ?? process.env.DATABASE_URL;
    if (!connectionString) throw new MigrationError('DATABASE_URL is not set.');
    const client = new pg.Client({ connectionString, application_name: 'diocom-migrate' });
    await client.connect();
    try {
        return await fn(client);
    } finally {
        await client.end().catch(() => undefined);
    }
}

/** Applies all pending migrations under the advisory lock. Throws (without applying anything) on integrity errors. */
export async function runMigrations(opts: RunOptions = {}): Promise<RunResult> {
    const log = opts.log ?? ((m: string) => console.info(m));
    const files = loadMigrations(opts.dir);
    return withClient(opts, async (client) => {
        await acquireMigrationLock(client, opts.lock);
        try {
            if (opts.afterLock) await opts.afterLock();
            await ensureMigrationsTable(client);
            let applied = await readApplied(client);
            let baselined: string | null = null;
            if (await isLegacyDatabase(client, applied)) {
                const first = files.find((f) => f.version === LEGACY_BASELINE.version);
                if (!first) throw new MigrationError(`Baseline migration ${LEGACY_BASELINE.version} not found in migrations directory.`);
                await baseline(client, first, log);
                baselined = first.filename;
                applied = await readApplied(client);
            }
            const plan = planMigrations(files, applied);
            if (plan.errors.length) throw new MigrationError(`Refusing to migrate:\n  - ${plan.errors.join('\n  - ')}`);
            const done: string[] = [];
            for (const m of plan.pending) {
                await applyOne(client, m, log);
                done.push(m.filename);
            }
            if (!done.length && !baselined) log('[migrate] Database schema is up to date.');
            const version = files.length ? Math.max(...(await readApplied(client)).map((a) => a.version), 0) : 0;
            return { applied: done, baselined, version };
        } finally {
            await releaseMigrationLock(client).catch(() => undefined);
        }
    });
}

export interface StatusResult {
    applied: AppliedMigration[];
    pending: Migration[];
    errors: string[];
    /** Tables exist but schema_migrations is empty: the next migrate will baseline. */
    legacy: boolean;
}

/** Read-only view of the migration state (takes no lock). */
export async function migrationStatus(opts: RunOptions = {}): Promise<StatusResult> {
    const files = loadMigrations(opts.dir);
    return withClient(opts, async (client) => {
        const applied = await readApplied(client);
        const legacy = await isLegacyDatabase(client, applied);
        const plan = planMigrations(files, applied);
        return { applied, pending: plan.pending, errors: plan.errors, legacy };
    });
}
