/**
 * Observability: readiness logic with mocked dependencies (diocom-app/src/lib/observability/health.ts).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { evaluateReadiness, livenessReport, describeError, type DbHealth } from '../diocom-app/src/lib/observability/health';

const okDb = async (): Promise<DbHealth> => ({ backend: 'postgres', pendingMigrations: 0, migrationErrors: 0 });

describe('readiness', () => {
    test('ready when the database is OK and optional deps are not configured', async () => {
        const r = await evaluateReadiness({ checkDatabase: okDb });
        assert.equal(r.status, 'ready');
        assert.equal(r.httpStatus, 200);
        assert.equal(r.checks.database.status, 'ok');
        assert.deepEqual(r.checks.database.detail, { backend: 'postgres', pendingMigrations: 0 });
        assert.equal(r.checks.redis.status, 'skipped');
        assert.equal(r.checks.reactor.status, 'skipped');
    });

    test('503 when the database is unreachable (error text scrubbed)', async () => {
        const r = await evaluateReadiness({
            checkDatabase: async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:5432 postgres://u:pw123@db/x'); },
        });
        assert.equal(r.httpStatus, 503);
        assert.equal(r.status, 'not_ready');
        assert.equal(r.checks.database.status, 'fail');
        assert.ok(!r.checks.database.error!.includes('10.1.2.3'));
        assert.ok(!r.checks.database.error!.includes('pw123'));
    });

    test('503 when migrations are pending or invalid', async () => {
        const pending = await evaluateReadiness({ checkDatabase: async () => ({ backend: 'postgres', pendingMigrations: 2, migrationErrors: 0 }) });
        assert.equal(pending.httpStatus, 503);
        assert.match(pending.checks.database.error!, /2 pending migration/);
        const invalid = await evaluateReadiness({ checkDatabase: async () => ({ backend: 'postgres', pendingMigrations: 0, migrationErrors: 1 }) });
        assert.equal(invalid.httpStatus, 503);
    });

    test('dev JSON store counts as ready', async () => {
        const r = await evaluateReadiness({ checkDatabase: async () => ({ backend: 'local', pendingMigrations: 0, migrationErrors: 0 }) });
        assert.equal(r.httpStatus, 200);
    });

    test('redis and reactor are checked only when configured', async () => {
        let redisPings = 0;
        const ok = await evaluateReadiness({ checkDatabase: okDb, pingRedis: async () => { redisPings++; }, pingReactor: async () => undefined });
        assert.equal(ok.httpStatus, 200);
        assert.equal(redisPings, 1);
        assert.equal(ok.checks.redis.status, 'ok');
        assert.equal(ok.checks.reactor.status, 'ok');

        const redisDown = await evaluateReadiness({ checkDatabase: okDb, pingRedis: async () => { throw new Error('ECONNREFUSED'); } });
        assert.equal(redisDown.httpStatus, 503);
        assert.equal(redisDown.checks.redis.status, 'fail');

        const reactorDown = await evaluateReadiness({ checkDatabase: okDb, pingReactor: async () => { throw new Error('reactor /health returned 502'); } });
        assert.equal(reactorDown.httpStatus, 503);
        assert.equal(reactorDown.checks.reactor.error, 'reactor /health returned 502');
    });

    test('a hanging dependency times out instead of hanging the probe', async () => {
        const t0 = Date.now();
        const r = await evaluateReadiness({ checkDatabase: () => new Promise(() => undefined), timeoutMs: 100 });
        assert.ok(Date.now() - t0 < 1000);
        assert.equal(r.httpStatus, 503);
        assert.match(r.checks.database.error!, /timed out/);
    });

    test('liveness and error description', () => {
        const l = livenessReport(0);
        assert.equal(l.status, 'ok');
        assert.equal(l.timestamp, '1970-01-01T00:00:00.000Z');
        assert.equal(describeError('x'.repeat(500)).length, 200);
    });
});
