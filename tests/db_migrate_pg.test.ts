/**
 * Integration tests for the migration runner and the migrated schema against a REAL PostgreSQL.
 *
 * Server, in order of preference:
 *   1. TEST_DATABASE_URL (any database on the server; used only to CREATE/DROP throwaway databases)
 *   2. DATABASE_URL from diocom-app/.env.local (same: the configured database itself is never touched)
 *   3. Docker: a temporary `postgres:16-alpine` (DIOCOM_TEST_PG_IMAGE) on a random localhost port
 * Otherwise (or with DIOCOM_SKIP_PG_TESTS=1) every test is skipped with the reason. Each test works in its own datran_test_<random> database,
 * all dropped afterwards; the container is removed.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { runMigrations, migrationStatus, loadMigrations } from '../diocom-app/src/db/migrate';
import { APP_DIR, runQueryPathScenario } from './helpers/dbScenario';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pg = require(path.join(APP_DIR, 'node_modules', 'pg'));
const MIGRATIONS = path.join(APP_DIR, 'migrations');
const LEGACY_SQL = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy_initialize_schema.sql'), 'utf8');
const quiet = () => undefined;

let adminUrl: string | null = null;
let skipReason = '';
let container: string | null = null;
const created: string[] = [];
const savedEnv = { ...process.env };

function envLocalDatabaseUrl(): string | null {
    try {
        const text = fs.readFileSync(path.join(APP_DIR, '.env.local'), 'utf8');
        const m = /^\s*DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(text);
        return m ? m[1].trim() : null;
    } catch {
        return null;
    }
}

async function canConnect(url: string): Promise<boolean> {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try {
        await c.connect();
        await c.query('SELECT 1');
        return true;
    } catch {
        return false;
    } finally {
        await c.end().catch(() => undefined);
    }
}

async function startDocker(): Promise<string | null> {
    const v = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000 });
    if (v.status !== 0) return null;
    const image = process.env.DIOCOM_TEST_PG_IMAGE || 'postgres:16-alpine';
    const name = `diocom-mig-test-${randomBytes(4).toString('hex')}`;
    const run = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=test', '-p', '127.0.0.1::5432', image],
        { encoding: 'utf8', timeout: 300_000 });
    if (run.status !== 0) {
        console.warn(`[db_migrate_pg] docker run failed: ${run.stderr}`);
        return null;
    }
    container = name;
    const port = spawnSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]?.split(':').pop();
    const url = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
        if (await canConnect(url)) return url;
        await new Promise((r) => setTimeout(r, 500));
    }
    return null;
}

function dbUrl(name: string): string {
    const u = new URL(adminUrl!);
    u.pathname = `/${name}`;
    return u.toString();
}

async function admin<T>(fn: (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    try {
        return await fn(c);
    } finally {
        await c.end();
    }
}

async function createDb(): Promise<string> {
    const name = `datran_test_${randomBytes(6).toString('hex')}`;
    await admin((c) => c.query(`CREATE DATABASE ${name}`));
    created.push(name);
    return dbUrl(name);
}

async function withDb<T>(url: string, fn: (c: { query: (s: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }> }) => Promise<T>): Promise<T> {
    const c = new pg.Client({ connectionString: url });
    await c.connect();
    try {
        return await fn(c);
    } finally {
        await c.end();
    }
}

/** Columns + types + nullability + defaults of the public schema (excluding schema_migrations). */
async function schemaSignature(url: string): Promise<string[]> {
    return withDb(url, async (c) => (await c.query(`
        SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default, '') AS def
        FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
        ORDER BY table_name, column_name`)).rows.map((r) => `${r.table_name}.${r.column_name} ${r.data_type} ${r.is_nullable} ${String(r.def).replace(/_seq\b.*$/, '_seq')}`));
}

function copyMigrations(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'diocom-migs-'));
    for (const f of fs.readdirSync(MIGRATIONS)) fs.copyFileSync(path.join(MIGRATIONS, f), path.join(d, f));
    return d;
}

const ALL = loadMigrations(MIGRATIONS).map((m) => m.filename);

describe('migrations against PostgreSQL', { timeout: 600_000 }, () => {
    before(async () => {
        if (process.env.DIOCOM_SKIP_PG_TESTS === '1') {
            skipReason = 'DIOCOM_SKIP_PG_TESTS=1';
            return;
        }
        for (const candidate of [process.env.TEST_DATABASE_URL, envLocalDatabaseUrl()]) {
            if (candidate && (await canConnect(candidate))) { adminUrl = candidate; break; }
        }
        if (!adminUrl && !skipReason) adminUrl = await startDocker();
        if (!adminUrl) {
            skipReason = 'No PostgreSQL available: set TEST_DATABASE_URL, put DATABASE_URL in diocom-app/.env.local, or install/start Docker.';
            console.warn(`[db_migrate_pg] SKIPPED — ${skipReason}`);
        }
    });

    after(async () => {
        process.env = savedEnv;
        const g = globalThis as { diocomHybridPool?: { end?: () => Promise<void> } };
        await g.diocomHybridPool?.end?.().catch(() => undefined);
        if (adminUrl) {
            for (const name of created) {
                await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)).catch((e) => console.warn(`drop ${name}: ${e.message}`));
            }
        }
        if (container) spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8', timeout: 60_000 });
    });

    test('fresh database: applies all migrations transactionally, then is a no-op', async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const url = await createDb();
        const r1 = await runMigrations({ connectionString: url, dir: MIGRATIONS, log: quiet });
        assert.deepEqual(r1.applied, ALL);
        assert.equal(r1.baselined, null);
        assert.equal(r1.version, ALL.length);
        const r2 = await runMigrations({ connectionString: url, dir: MIGRATIONS, log: quiet });
        assert.deepEqual(r2.applied, []);
        const s = await migrationStatus({ connectionString: url, dir: MIGRATIONS });
        assert.deepEqual([s.pending.length, s.errors, s.legacy], [0, [], false]);
        await withDb(url, async (c) => {
            const rows = (await c.query('SELECT version, checksum, baseline FROM schema_migrations ORDER BY version')).rows;
            assert.equal(rows.length, ALL.length);
            assert.ok(rows.every((r) => /^[0-9a-f]{64}$/.test(String(r.checksum)) && r.baseline === false));
            assert.equal((await c.query("SELECT data_type FROM information_schema.columns WHERE table_name = 'audit_logs' AND column_name = 'details'")).rows[0].data_type, 'text');
        });
    });

    test('concurrent migrators are serialised by the advisory lock; each migration applied once', async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const url = await createDb();
        let active = 0;
        let maxActive = 0;
        const afterLock = async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 100));
            active--;
        };
        const results = await Promise.all(Array.from({ length: 4 }, () =>
            runMigrations({ connectionString: url, dir: MIGRATIONS, log: quiet, afterLock, lock: { timeoutMs: 60_000, pollMs: 20 } })));
        assert.equal(maxActive, 1, 'only one migrator inside the lock at a time');
        assert.deepEqual(results.flatMap((r) => r.applied).sort(), [...ALL].sort());
        await withDb(url, async (c) => assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, ALL.length));
    });

    test('a held lock makes another migrator time out instead of racing', async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const url = await createDb();
        await withDb(url, async (holder) => {
            await holder.query("SELECT pg_advisory_lock('431214522733'::bigint)");
            await assert.rejects(runMigrations({ connectionString: url, dir: MIGRATIONS, log: quiet, lock: { timeoutMs: 300, pollMs: 50 } }), /Timed out .* migration lock/);
        });
        assert.equal((await runMigrations({ connectionString: url, dir: MIGRATIONS, log: quiet })).applied.length, ALL.length, 'lock released with the session');
    });

    test('refuses to run when an applied migration file was modified', async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const url = await createDb();
        const dir = copyMigrations();
        await runMigrations({ connectionString: url, dir, log: quiet });
        fs.appendFileSync(path.join(dir, '0001_initial.sql'), '\nCREATE TABLE sneaky (a int);\n');
        fs.writeFileSync(path.join(dir, '0099_new.sql'), 'CREATE TABLE should_not_exist (a int);');
        await assert.rejects(runMigrations({ connectionString: url, dir, log: quiet }), /0001_initial\.sql was modified after it was applied/);
        const s = await migrationStatus({ connectionString: url, dir });
        assert.equal(s.errors.length, 1);
        await withDb(url, async (c) => assert.equal((await c.query("SELECT to_regclass('should_not_exist') AS t")).rows[0].t, null, 'nothing applied'));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('a failing migration is rolled back completely', async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const url = await createDb();
        const dir = copyMigrations();
        const next = String(ALL.length + 1).padStart(4, '0');
        fs.writeFileSync(path.join(dir, `${next}_broken.sql`), 'CREATE TABLE half_done (a int);\nALTER TABLE files ADD COLUMN x INT;\nSELECT no_such_column FROM files;');
        await assert.rejects(runMigrations({ connectionString: url, dir, log: quiet }), new RegExp(`${next}_broken\\.sql failed and was rolled back`));
        await withDb(url, async (c) => {
            assert.equal((await c.query("SELECT to_regclass('half_done') AS t")).rows[0].t, null);
            assert.equal((await c.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'files' AND column_name = 'x'")).rows[0].n, 0);
            assert.equal((await c.query('SELECT max(version)::int AS v FROM schema_migrations')).rows[0].v, ALL.length, 'earlier migrations stay applied');
        });
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('legacy initializeSchema database is verified, repaired, baselined at 0001, then migrated', async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const fresh = await createDb();
        await runMigrations({ connectionString: fresh, dir: MIGRATIONS, log: quiet });
        const legacy = await createDb();
        await withDb(legacy, async (c) => {
            await c.query(LEGACY_SQL);
            await c.query("INSERT INTO users (id, email, created_at) VALUES ('u1', 'a@b.c', 1)");
            await c.query("INSERT INTO files (id, user_id, share_id, original_name, sanitized_name, storage_path, file_size, created_at) VALUES ('f1', 'u1', 's1', 'a', 'a', '/a', 1, 1)");
            await c.query("INSERT INTO analytics (id, file_id, event_type, timestamp) VALUES ('a1', 'f1', 'view', 1)");
            await c.query(`INSERT INTO audit_logs (id, action, resource, details, timestamp, hash) VALUES ('l1', 'X', 'r', '"Viewed shared file"', 1, 'h')`);
        });
        const st = await migrationStatus({ connectionString: legacy, dir: MIGRATIONS });
        assert.equal(st.legacy, true);
        const r = await runMigrations({ connectionString: legacy, dir: MIGRATIONS, log: quiet });
        assert.equal(r.baselined, '0001_initial.sql');
        assert.deepEqual(r.applied, ALL.slice(1));
        assert.deepEqual(await schemaSignature(legacy), await schemaSignature(fresh), 'baselined schema == fresh schema');
        await withDb(legacy, async (c) => {
            assert.equal((await c.query('SELECT baseline FROM schema_migrations WHERE version = 1')).rows[0].baseline, true);
            assert.equal((await c.query("SELECT details FROM audit_logs WHERE id = 'l1'")).rows[0].details, 'Viewed shared file');
            // 0002: deleting a viewed file no longer violates the analytics foreign key
            assert.equal((await c.query("DELETE FROM files WHERE id = 'f1'")).rowCount, 1);
            assert.equal((await c.query('SELECT count(*)::int AS n FROM analytics')).rows[0].n, 0);
        });
    });

    test('an unrelated existing schema is not baselined', async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const url = await createDb();
        await withDb(url, (c) => c.query('CREATE TABLE users (id TEXT PRIMARY KEY)'));
        await assert.rejects(runMigrations({ connectionString: url, dir: MIGRATIONS, log: quiet }), /not a recognised legacy schema.*table files.*column users\.email/s);
        await withDb(url, async (c) => assert.equal((await c.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 0));
    });

    const freshPool = () => {
        const p = path.join(APP_DIR, 'src', 'db', 'index.ts');
        delete require.cache[require.resolve(p)];
        delete (globalThis as { diocomHybridPool?: unknown }).diocomHybridPool;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(p);
    };

    test('production startup: refuses pending migrations; DB_AUTO_MIGRATE=true applies them', async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const url = await createDb();
        Object.assign(process.env, { NODE_ENV: 'production', DATABASE_URL: url, DB_MIGRATIONS_DIR: MIGRATIONS });
        delete process.env.DB_AUTO_MIGRATE;
        try {
            let m = freshPool();
            await assert.rejects(m.ensureDatabaseReady(), /pending database migration\(s\).*npm run db:migrate/s);
            await m.default.end();
            process.env.DB_AUTO_MIGRATE = 'true';
            m = freshPool();
            assert.equal(await m.ensureDatabaseReady(), 'postgres');
            await m.default.end();
            delete process.env.DB_AUTO_MIGRATE;
            m = freshPool();
            assert.equal(await m.ensureDatabaseReady(), 'postgres', 'up to date: starts without auto-migrate');
            await m.default.end();
        } finally {
            process.env.NODE_ENV = 'test';
            delete process.env.DB_AUTO_MIGRATE;
            delete (globalThis as { diocomHybridPool?: unknown }).diocomHybridPool;
        }
    });

    test("the app's query paths run against the migrated schema", async (t) => {
        if (!adminUrl) return t.skip(skipReason);
        const url = await createDb();
        await runMigrations({ connectionString: url, dir: MIGRATIONS, log: quiet });
        Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: url, DB_MIGRATIONS_DIR: MIGRATIONS });
        freshPool();
        await runQueryPathScenario('postgres');
    });
});
