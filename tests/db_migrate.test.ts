/**
 * Unit tests for the migration runner (diocom-app/src/db/migrate.ts): file parsing, checksums, integrity planning,
 * advisory-lock polling and legacy-baseline classification — no database needed. Also checks that the baseline
 * column list matches migrations/0001_initial.sql exactly.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    checksumOf, parseMigrationFilename, loadMigrations, planMigrations, diffSchema, classifyBaselineDiff,
    acquireMigrationLock, LEGACY_BASELINE, MIGRATION_LOCK_KEY, type AppliedMigration, type Migration,
} from '../diocom-app/src/db/migrate';

const MIGRATIONS = path.resolve(__dirname, '..', 'diocom-app', 'migrations');

function tmpDir(files: Record<string, string>): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'diocom-mig-'));
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(d, n), c);
    return d;
}
const applied = (m: Migration, checksum = m.checksum): AppliedMigration =>
    ({ version: m.version, name: m.name, checksum, applied_at: new Date(), baseline: false });

describe('checksums and filenames', () => {
    test('checksum ignores CRLF vs LF and a BOM, but not content', () => {
        const lf = 'CREATE TABLE a (id int);\nSELECT 1;\n';
        assert.equal(checksumOf(lf), checksumOf(lf.replace(/\n/g, '\r\n')));
        assert.equal(checksumOf(lf), checksumOf('﻿' + lf));
        assert.notEqual(checksumOf(lf), checksumOf(lf + ' '));
        assert.match(checksumOf(lf), /^[0-9a-f]{64}$/);
    });
    test('filename pattern', () => {
        assert.deepEqual(parseMigrationFilename('0001_initial.sql'), { version: 1, name: 'initial' });
        assert.deepEqual(parseMigrationFilename('0012_add_x_2.sql'), { version: 12, name: 'add_x_2' });
        assert.equal(parseMigrationFilename('1_init.sql'), null);
        assert.equal(parseMigrationFilename('0001-init.sql'), null);
        assert.equal(parseMigrationFilename('0001_Init.sql'), null);
    });
});

describe('loadMigrations', () => {
    test('sorted, checksummed, no-transaction directive detected, non-sql ignored', () => {
        const d = tmpDir({
            '0002_b.sql': '-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY x ON t(a);',
            '0001_a.sql': 'CREATE TABLE t (a int);',
            'README.txt': 'ignored',
        });
        const m = loadMigrations(d);
        assert.deepEqual(m.map((x) => x.filename), ['0001_a.sql', '0002_b.sql']);
        assert.equal(m[0].transactional, true);
        assert.equal(m[1].transactional, false);
        assert.equal(m[0].checksum, checksumOf('CREATE TABLE t (a int);'));
    });
    test('duplicate versions and bad names are errors', () => {
        assert.throws(() => loadMigrations(tmpDir({ '0001_a.sql': '', '0001_b.sql': '' })), /Duplicate migration version 1/);
        assert.throws(() => loadMigrations(tmpDir({ 'init.sql': '' })), /Bad migration filename/);
        assert.throws(() => loadMigrations(path.join(os.tmpdir(), 'does-not-exist-diocom')), /not found/);
    });
    test('the repository migrations load cleanly and start at 0001', () => {
        const m = loadMigrations(MIGRATIONS);
        assert.equal(m[0].filename, '0001_initial.sql');
        m.forEach((x, i) => assert.equal(x.version, i + 1, 'versions are contiguous'));
    });
});

describe('planMigrations (integrity)', () => {
    const files = loadMigrations(tmpDir({ '0001_a.sql': 'A', '0002_b.sql': 'B', '0003_c.sql': 'C' }));
    test('fresh database: everything pending', () => {
        const p = planMigrations(files, []);
        assert.deepEqual(p.errors, []);
        assert.equal(p.pending.length, 3);
    });
    test('partially applied: only the rest pending', () => {
        const p = planMigrations(files, [applied(files[0]), applied(files[1])]);
        assert.deepEqual(p.pending.map((x) => x.version), [3]);
        assert.deepEqual(p.errors, []);
    });
    test('modified applied file is refused', () => {
        const p = planMigrations(files, [applied(files[0], checksumOf('A original'))]);
        assert.equal(p.errors.length, 1);
        assert.match(p.errors[0], /0001_a\.sql was modified after it was applied/);
    });
    test('applied migration whose file vanished is refused (code older than DB)', () => {
        const p = planMigrations(files.slice(0, 1), [applied(files[0]), applied(files[1])]);
        assert.match(p.errors.join('\n'), /Migration 2 \(b\) is applied in the database but its file is missing/);
    });
    test('new file numbered below the latest applied version is refused (out of order)', () => {
        const p = planMigrations(files, [applied(files[0]), applied(files[2])]);
        assert.match(p.errors.join('\n'), /0002_b\.sql is older than the latest applied version 3/);
    });
});

describe('advisory lock', () => {
    function fakeClient(answers: boolean[]) {
        const calls: { sql: string; params?: unknown[] }[] = [];
        return {
            calls,
            query: async (sql: string, params?: unknown[]) => {
                calls.push({ sql, params });
                return { rows: [{ ok: answers.length ? answers.shift() : false }] };
            },
        };
    }
    test('polls pg_try_advisory_lock with the shared key until granted', async () => {
        const c = fakeClient([false, false, true]);
        await acquireMigrationLock(c as never, { timeoutMs: 5_000, pollMs: 1 });
        assert.equal(c.calls.length, 3);
        assert.match(c.calls[0].sql, /pg_try_advisory_lock\(\$1::bigint\)/);
        assert.deepEqual(c.calls[0].params, [MIGRATION_LOCK_KEY]);
    });
    test('times out with a clear error', async () => {
        const c = fakeClient([]);
        await assert.rejects(acquireMigrationLock(c as never, { timeoutMs: 30, pollMs: 5 }), /Timed out after 30 ms waiting for the migration lock/);
    });
});

describe('legacy baseline', () => {
    const full = () => new Map(Object.entries(LEGACY_BASELINE.tables).map(([t, cols]) => [t, new Set(cols)]));
    test('complete legacy schema: nothing to repair', () => {
        const d = diffSchema(full());
        assert.deepEqual(d, { missingTables: [], missingColumns: [] });
        assert.deepEqual(classifyBaselineDiff(d), { repairs: [], blocking: [] });
    });
    test('older legacy schema without reactor columns / access_events is repairable', () => {
        const s = full();
        s.delete('access_events');
        s.get('files')!.delete('reactor_class');
        s.get('files')!.delete('reactor_recipe');
        const r = classifyBaselineDiff(diffSchema(s));
        assert.deepEqual(r.blocking, []);
        assert.equal(r.repairs.length, 2);
        assert.ok(r.repairs.some((x) => /ADD COLUMN IF NOT EXISTS reactor_class/.test(x)));
        assert.ok(r.repairs.some((x) => /CREATE TABLE IF NOT EXISTS access_events/.test(x)));
    });
    test('anything else missing blocks the baseline', () => {
        const s = full();
        s.delete('spaces');
        s.get('users')!.delete('email');
        const r = classifyBaselineDiff(diffSchema(s));
        assert.deepEqual(r.blocking.sort(), ['column users.email', 'table spaces']);
    });
    test('LEGACY_BASELINE matches the tables/columns of 0001_initial.sql exactly', () => {
        const sql = fs.readFileSync(path.join(MIGRATIONS, '0001_initial.sql'), 'utf8').replace(/--.*$/gm, '');
        const parsed: Record<string, string[]> = {};
        for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
            parsed[m[1]] = m[2].split('\n').map((l) => l.trim()).filter((l) => l && !/^(PRIMARY KEY|CONSTRAINT|UNIQUE|FOREIGN KEY)\b/.test(l))
                .map((l) => l.split(/\s+/)[0]);
        }
        assert.deepEqual(
            Object.fromEntries(Object.entries(parsed).map(([t, c]) => [t, [...c].sort()])),
            Object.fromEntries(Object.entries(LEGACY_BASELINE.tables).map(([t, c]) => [t, [...c].sort()]))
        );
    });
});
