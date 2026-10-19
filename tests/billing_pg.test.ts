/**
 * Billing + mobile-auth SQL against a REAL PostgreSQL migrated by migrations/ (same server discovery as
 * db_migrate_pg.test.ts: TEST_DATABASE_URL, diocom-app/.env.local DATABASE_URL, or a throwaway Docker postgres).
 * Proves: concurrent debits never take a balance negative, idempotency keys under concurrency, the CHECK backstop,
 * atomic storage reservation, delete releasing storage, egress flush, Stripe upserts and refresh rotation races.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { APP_DIR, installAppAlias } from './helpers/dbScenario';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pg = require(path.join(APP_DIR, 'node_modules', 'pg'));

let adminUrl: string | null = null;
let container: string | null = null;
let dbName: string | null = null;
let skipReason = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let app: Record<string, any> = {};

async function canConnect(url: string) {
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
    try { await c.connect(); await c.query('SELECT 1'); return true; } catch { return false; } finally { await c.end().catch(() => undefined); }
}
function envLocalDatabaseUrl(): string | null {
    try {
        const m = /^\s*DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(fs.readFileSync(path.join(APP_DIR, '.env.local'), 'utf8'));
        return m ? m[1].trim() : null;
    } catch { return null; }
}
async function startDocker(): Promise<string | null> {
    if (spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 15_000 }).status !== 0) return null;
    const name = `diocom-billing-test-${randomBytes(4).toString('hex')}`;
    const run = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-e', 'POSTGRES_PASSWORD=test', '-p', '127.0.0.1::5432', process.env.DIOCOM_TEST_PG_IMAGE || 'postgres:16-alpine'], { encoding: 'utf8', timeout: 300_000 });
    if (run.status !== 0) return null;
    container = name;
    const port = spawnSync('docker', ['port', name, '5432/tcp'], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/)[0]?.split(':').pop();
    const url = `postgres://postgres:test@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { if (await canConnect(url)) return url; await new Promise((r) => setTimeout(r, 500)); }
    return null;
}

async function newUser(): Promise<string> {
    const id = randomUUID();
    await app.db.query('INSERT INTO users (id, name, email, password_hash, image, provider, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, 'P', `${id}@pg.io`, null, '', 'credentials', 'user', Date.now()]);
    return id;
}

describe('billing against PostgreSQL', { timeout: 600_000 }, () => {
    before(async () => {
        if (process.env.DIOCOM_SKIP_PG_TESTS === '1') { skipReason = 'DIOCOM_SKIP_PG_TESTS=1'; return; }
        for (const c of [process.env.TEST_DATABASE_URL, envLocalDatabaseUrl()]) if (c && (await canConnect(c))) { adminUrl = c; break; }
        if (!adminUrl) adminUrl = await startDocker();
        if (!adminUrl) { skipReason = 'No PostgreSQL available (TEST_DATABASE_URL / .env.local / Docker)'; console.warn(`[billing_pg] SKIPPED — ${skipReason}`); return; }
        dbName = `datran_billing_${randomBytes(5).toString('hex')}`;
        const admin = new pg.Client({ connectionString: adminUrl });
        await admin.connect();
        await admin.query(`CREATE DATABASE ${dbName}`);
        await admin.end();
        const u = new URL(adminUrl);
        u.pathname = `/${dbName}`;
        Object.assign(process.env, {
            NODE_ENV: 'test', DATABASE_URL: u.toString(), DB_AUTO_MIGRATE: 'true', DB_MIGRATIONS_DIR: path.join(APP_DIR, 'migrations'),
            DIOCOM_SECRET: 'pg-secret', LOG_LEVEL: 'silent', STRIPE_SECRET_KEY: 'sk_test_dummy', DB_POOL_MAX: '30',
        });
        delete (globalThis as { diocomHybridPool?: unknown }).diocomHybridPool;
        installAppAlias();
        /* eslint-disable @typescript-eslint/no-require-imports */
        const SRC = path.join(APP_DIR, 'src');
        const dbm = require(path.join(SRC, 'db', 'index.ts'));
        app = {
            db: dbm.default,
            ready: dbm.ensureDatabaseReady,
            credits: require(path.join(SRC, 'lib', 'billing', 'credits.ts')),
            usage: require(path.join(SRC, 'lib', 'billing', 'usage.ts')),
            files: require(path.join(SRC, 'db', 'files.ts')),
            wh: require(path.join(SRC, 'lib', 'billing', 'webhook.ts')),
            ent: require(path.join(SRC, 'lib', 'billing', 'entitlement.ts')),
            mt: require(path.join(SRC, 'lib', 'auth', 'mobileTokens.ts')),
            kv: require(path.join(SRC, 'lib', 'kv', 'index.ts')),
        };
        /* eslint-enable @typescript-eslint/no-require-imports */
        assert.equal(await app.ready(), 'postgres');
    });

    after(async () => {
        await app.db?.end?.().catch(() => undefined);
        if (adminUrl && dbName) {
            const admin = new pg.Client({ connectionString: adminUrl });
            await admin.connect();
            await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
            await admin.end();
        }
        if (container) spawnSync('docker', ['rm', '-f', container], { encoding: 'utf8', timeout: 60_000 });
    });

    const t = (name: string, fn: () => Promise<void>) => test(name, async (ctx) => { if (!adminUrl) return ctx.skip(skipReason); await fn(); });

    t('50 concurrent debits on a balance of 10 -> exactly 10 succeed, balance 0, never negative', async () => {
        const u = await newUser();
        await app.credits.grantCredits(u, 10, { type: 'grant' });
        const results = await Promise.all(Array.from({ length: 50 }, () => app.credits.debitCredits(u, 1, { type: 'egress' })));
        assert.equal(results.filter((r: { ok: boolean }) => r.ok).length, 10);
        assert.equal(await app.credits.getBalance(u), 0);
        const ledger = await app.credits.listLedger(u, 100);
        assert.equal(ledger.filter((e: { type: string }) => e.type === 'egress').length, 10);
        const sum = ledger.reduce((a: number, e: { amount: number }) => a + e.amount, 0);
        assert.equal(Math.round(sum * 1e6) / 1e6, 0, 'ledger sums to the balance');
    });

    t('fractional concurrent debits stay exact (NUMERIC) and >= 0', async () => {
        const u = await newUser();
        await app.credits.grantCredits(u, 1, { type: 'grant' });
        const results = await Promise.all(Array.from({ length: 40 }, () => app.credits.debitCredits(u, 0.034567, { type: 'egress' })));
        const ok = results.filter((r: { ok: boolean }) => r.ok).length;
        assert.equal(ok, 28); // floor(1 / 0.034567)
        assert.equal(await app.credits.getBalance(u), Math.round((1 - 28 * 0.034567) * 1e6) / 1e6);
    });

    t('same idempotency key under concurrency: one debit, one grant', async () => {
        const u = await newUser();
        const grants = await Promise.all(Array.from({ length: 10 }, () => app.credits.grantCredits(u, 100, { type: 'purchase', idempotencyKey: `g:${u}` })));
        assert.equal(grants.filter((r: { replay: boolean }) => !r.replay).length, 1);
        assert.equal(await app.credits.getBalance(u), 100);
        const debits = await Promise.all(Array.from({ length: 20 }, () => app.credits.debitCredits(u, 5, { type: 'egress', idempotencyKey: `d:${u}` })));
        assert.ok(debits.every((r: { ok: boolean }) => r.ok));
        assert.equal(debits.filter((r: { replay: boolean }) => !r.replay).length, 1);
        assert.equal(await app.credits.getBalance(u), 95);
        assert.equal((await app.credits.listLedger(u)).length, 2);
    });

    t('CHECK (balance >= 0) backstop and clawback of unused credits only', async () => {
        const u = await newUser();
        await app.credits.grantCredits(u, 3, { type: 'grant' });
        await assert.rejects(app.db.query('UPDATE user_credits SET balance = balance - 10 WHERE user_id = $1', [u]), /user_credits_balance_nonnegative/);
        const r = await app.credits.clawbackCredits(u, 5, { idempotencyKey: `c:${u}` });
        assert.equal(r.removed, 3);
        assert.equal((await app.credits.clawbackCredits(u, 5, { idempotencyKey: `c:${u}` })).replay, true);
        assert.equal(await app.credits.getBalance(u), 0);
    });

    t('storage reservation is atomic under concurrency; delete releases', async () => {
        const u = await newUser();
        const res = await Promise.all(Array.from({ length: 25 }, () => app.usage.reserveStorage(u, 100, 1000)));
        assert.equal(res.filter(Boolean).length, 10);
        assert.equal((await app.usage.getStorageUsage(u)).storageBytes, 1000);
        await app.usage.releaseStorage(u, 600);
        const f = await app.files.FileRepository.create({
            user_id: u, share_id: `pg${randomUUID().slice(0, 10)}`, original_name: 'a', sanitized_name: 'a', storage_path: '/x', file_size: 300,
            mime_type: 'text/plain', expires_at: Date.now() - 1, compression_ratio: null, compression_speed: null, is_encrypted: 0,
        });
        await app.files.FileRepository.delete(f.id);
        assert.equal((await app.usage.getStorageUsage(u)).storageBytes, 100);
        await app.usage.incrementMonthlyUploads(u);
        await app.usage.incrementMonthlyUploads(u);
        assert.equal((await app.usage.getMonthlyUsage(u)).uploadsCount, 2);
    });

    t('egress flush sums the KV batch into usage_monthly (one row per subject+month)', async () => {
        app.kv.setKVForTesting(new app.kv.MemoryKV());
        const u = await newUser();
        await Promise.all(Array.from({ length: 30 }, () => app.usage.recordEgressBytes(u, 1000)));
        await app.usage.recordEgressBytes(u, -500);
        assert.equal(await app.usage.flushEgress(), 1);
        assert.equal((await app.usage.getMonthlyUsage(u)).egressBytes, 29_500);
        await app.usage.recordEgressBytes(u, 500);
        await app.usage.flushEgress();
        assert.equal((await app.usage.getMonthlyUsage(u)).egressBytes, 30_000);
    });

    t('Stripe subscription upsert / invoice SQL and processed_events on PostgreSQL', async () => {
        const u = await newUser();
        const now = Math.floor(Date.now() / 1000);
        const sub = (status: string) => ({ id: `sub_${u.slice(0, 8)}`, status, customer: 'cus_pg', cancel_at_period_end: false, metadata: { userId: u },
            items: { data: [{ current_period_end: now + 86400, price: { id: 'price_x', recurring: { interval: 'year' } } }] } });
        const evt = (type: string, object: unknown, created: number) => ({ id: `evt_${randomUUID()}`, type, created, data: { object } });
        assert.equal(await app.wh.processStripeEvent(evt('customer.subscription.created', sub('active'), now), {}), 'processed');
        const e2 = evt('invoice.payment_failed', { id: 'in', parent: { subscription_details: { subscription: `sub_${u.slice(0, 8)}` } } }, now + 1);
        await app.wh.processStripeEvent(e2, {});
        assert.equal(await app.wh.processStripeEvent(e2, {}), 'duplicate');
        assert.equal((await app.ent.listSubscriptions(u))[0].status, 'past_due');
        assert.equal(await app.ent.getUserPlanId(u), 'pro');
        await app.wh.processStripeEvent(evt('customer.subscription.updated', sub('canceled'), now - 10), {});
        assert.equal((await app.ent.listSubscriptions(u))[0].status, 'past_due', 'stale event ignored');
        await app.wh.processStripeEvent(evt('invoice.paid', { id: 'in2', parent: { subscription_details: { subscription: `sub_${u.slice(0, 8)}` } } }, now + 2), {});
        const s = (await app.ent.listSubscriptions(u))[0];
        assert.equal(s.status, 'active');
        assert.equal(s.billing_interval, 'year');
    });

    t('refresh rotation race on PostgreSQL: one winner at most, family revoked', async () => {
        const u = await newUser();
        const p = await app.mt.issueTokenPair({ id: u });
        const rs = await Promise.all(Array.from({ length: 5 }, () => app.mt.rotateRefreshToken(p.refreshToken)));
        assert.ok(rs.filter((r: { ok: boolean }) => r.ok).length <= 1);
        assert.ok(rs.some((r: { reason?: string }) => r.reason === 'reused'));
        const winner = rs.find((r: { ok: boolean }) => r.ok);
        if (winner) assert.equal((await app.mt.rotateRefreshToken(winner.pair.refreshToken)).ok, false, 'winner revoked with the family');
    });
});
