/**
 * The dev-only JSON store (diocom-app/src/db/localStore.ts) runs every app query path (shared scenario with the
 * PostgreSQL test), rejects unregistered SQL instead of returning empty rows, and src/db/index.ts refuses to run
 * without PostgreSQL in production.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runQueryPathScenario, loadApp, APP_DIR } from './helpers/dbScenario';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diocom-localdb-'));
const saved = { ...process.env };

before(() => {
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = 'test';
    process.env.LOCAL_DB_PATH = path.join(tmp, 'local_db.json');
    process.env.DIOCOM_STORAGE_PATH = path.join(tmp, 'storage');
    process.env.DB_MIGRATIONS_DIR = path.join(APP_DIR, 'migrations');
});

after(() => {
    process.env = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('dev JSON store', () => {
    test('runs every app query path', async () => {
        await runQueryPathScenario('local');
        assert.ok(fs.existsSync(process.env.LOCAL_DB_PATH!));
    });

    test('unsupported SQL throws instead of returning empty rows', async () => {
        const { db } = loadApp();
        await assert.rejects(db.query('SELECT * FROM users WHERE name = $1', ['x']), /not supported by the dev JSON store/);
        await assert.rejects(db.query('UPDATE files SET summary = $1 WHERE id = $2', ['s', 'x']), /not supported/);
        await assert.rejects(db.query('DELETE FROM users WHERE id = $1', ['x']), /not supported/);
        await assert.rejects(db.query('INSERT INTO nope (a) VALUES ($1)', [1]), /not supported/);
        await assert.rejects(
            db.query('INSERT INTO chunks (id, original_size, hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET hash = EXCLUDED.hash', ['a', 1, 'h']),
            /not supported/
        );
    });

    test('plain INSERT with a duplicate primary key fails like PostgreSQL', async () => {
        const { db } = loadApp();
        await db.query('INSERT INTO chunks (id, original_size, hash) VALUES ($1, $2, $3)', ['dup', 1, 'hdup']);
        await assert.rejects(db.query('INSERT INTO chunks (id, original_size, hash) VALUES ($1, $2, $3)', ['dup', 1, 'hdup2']), /duplicate key/);
    });

    test('string literals in VALUES keep their case', async () => {
        const { db } = loadApp();
        await db.query("INSERT INTO qr_sessions (id, creator_id, status, file_ids, created_at, expires_at) VALUES ($1, $2, 'Waiting', $3, $4, $5)", ['q1', null, '[]', 1, 2]);
        assert.equal((await db.query('SELECT * FROM qr_sessions WHERE id = $1', ['q1'])).rows[0].status, 'Waiting');
    });
});

describe('production requires PostgreSQL', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const freshPool = () => {
        const p = path.join(APP_DIR, 'src', 'db', 'index.ts');
        delete require.cache[require.resolve(p)];
        delete (globalThis as { diocomHybridPool?: unknown }).diocomHybridPool;
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(p);
    };

    test('no DATABASE_URL -> refuses (even with the removed DB_ALLOW_LOCAL_FALLBACK=true)', async () => {
        process.env.NODE_ENV = 'production';
        process.env.DB_ALLOW_LOCAL_FALLBACK = 'true';
        delete process.env.DATABASE_URL;
        try {
            const m = freshPool();
            await assert.rejects(m.ensureDatabaseReady(), /DATABASE_URL is not set/);
            await assert.rejects(m.default.query('SELECT * FROM users WHERE id = $1', ['x']), m.DatabaseUnavailableError);
        } finally {
            process.env.NODE_ENV = 'test';
            delete process.env.DB_ALLOW_LOCAL_FALLBACK;
        }
    });

    test('unreachable PostgreSQL -> refuses, no JSON fallback', async () => {
        process.env.NODE_ENV = 'production';
        process.env.DATABASE_URL = 'postgres://u:p@127.0.0.1:1/none';
        try {
            const m = freshPool();
            await assert.rejects(m.ensureDatabaseReady(), /PostgreSQL is unreachable/);
            await m.default.end();
        } finally {
            process.env.NODE_ENV = 'test';
            delete process.env.DATABASE_URL;
            delete (globalThis as { diocomHybridPool?: unknown }).diocomHybridPool;
        }
    });
});
