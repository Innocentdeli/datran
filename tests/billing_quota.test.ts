/**
 * Plans & quotas: limit math (env-configurable plans), upload enforcement (file size, storage reservation, release on
 * delete), egress enforcement (owner quota -> credits -> 402) and egress batching through the shared KV.
 * Runs against the dev JSON store (no DATABASE_URL) and the in-memory KV.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { installAppAlias, APP_DIR } from './helpers/dbScenario';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diocom-billing-'));
Object.assign(process.env, { NODE_ENV: 'test', LOCAL_DB_PATH: path.join(tmp, 'db.json'), DIOCOM_SECRET: 'test-secret', LOG_LEVEL: 'silent' });
delete process.env.DATABASE_URL;
delete process.env.REDIS_URL;
installAppAlias();

/* eslint-disable @typescript-eslint/no-require-imports */
const SRC = path.join(APP_DIR, 'src');
const plans = require(path.join(SRC, 'lib', 'billing', 'plans.ts'));
const enforce = require(path.join(SRC, 'lib', 'billing', 'enforce.ts'));
const usage = require(path.join(SRC, 'lib', 'billing', 'usage.ts'));
const credits = require(path.join(SRC, 'lib', 'billing', 'credits.ts'));
const errors = require(path.join(SRC, 'lib', 'billing', 'errors.ts'));
const kvMod = require(path.join(SRC, 'lib', 'kv', 'index.ts'));
const db = require(path.join(SRC, 'db', 'index.ts')).default;
const { FileRepository } = require(path.join(SRC, 'db', 'files.ts'));
/* eslint-enable @typescript-eslint/no-require-imports */

const MB = 1024 * 1024;
const GB = 1024 * MB;

async function newUser(): Promise<string> {
    const id = randomUUID();
    await db.query('INSERT INTO users (id, name, email, password_hash, image, provider, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [id, 'U', `${id}@x.io`, null, '', 'credentials', 'user', Date.now()]);
    return id;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
    return async () => {
        const saved: Record<string, string | undefined> = {};
        for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
        try { await fn(); } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    };
}

describe('plan definitions', () => {
    test('defaults, env overrides, unlimited and the server ceiling', withEnv({ PLAN_FREE_STORAGE_GB: undefined, PLAN_PRO_EGRESS_GB: 'unlimited', PLAN_FREE_MAX_FILE_MB: '50', MAX_UPLOAD_BYTES: undefined }, () => {
        const free = plans.getPlan('free');
        assert.equal(free.storageQuotaBytes, 2 * GB);
        assert.equal(free.monthlyEgressBytes, 10 * GB);
        assert.equal(free.maxFileBytes, 50 * MB);
        assert.equal(free.maxExpiryHours, 168);
        const pro = plans.getPlan('pro');
        assert.equal(pro.monthlyEgressBytes, null, 'unlimited');
        assert.ok(pro.maxFileBytes <= plans.serverMaxFileBytes(), 'capped by MAX_FILE_SIZE');
        const anon = plans.getPlan('anonymous');
        assert.equal(anon.storageQuotaBytes, null);
        assert.equal(anon.maxExpiryHours, 24);
        assert.equal(plans.largestPlanFileBytes(), Math.max(free.maxFileBytes, pro.maxFileBytes, anon.maxFileBytes));
    }));

    test('legacy MAX_UPLOAD_BYTES is the Free file-size default', withEnv({ PLAN_FREE_MAX_FILE_MB: undefined, MAX_UPLOAD_BYTES: String(7 * MB) }, () => {
        assert.equal(plans.getPlan('free').maxFileBytes, 7 * MB);
    }));

    test('egress cost rounds up to 6 decimals; expiry clamps; periods', withEnv({ CREDITS_PER_GB: '2' }, () => {
        assert.equal(plans.egressCost(GB), 2);
        assert.equal(plans.egressCost(GB / 2), 1);
        assert.equal(plans.egressCost(1), 0.000001, 'tiny overage is never free (rounded up)');
        assert.equal(plans.egressCost(0), 0);
        const free = plans.getPlan('free');
        assert.equal(plans.resolveExpiryHours(free, null), 168);
        assert.equal(plans.resolveExpiryHours(free, 10_000), 168);
        assert.equal(plans.resolveExpiryHours(free, 2), 2);
        assert.equal(plans.usagePeriod(Date.UTC(2026, 9, 31, 23, 59)), '2026-10');
        assert.equal(plans.periodResetAt(Date.UTC(2026, 11, 15)), Date.UTC(2027, 0, 1));
    }));

    test('QuotaError JSON carries limit, plan and an upgrade hint', () => {
        const e = new errors.QuotaError('storage', 'full', 'free', { limitBytes: 10, usedBytes: 9 });
        assert.equal(e.status, 402);
        const j = e.toJSON();
        assert.equal(j.code, 'STORAGE_QUOTA_EXCEEDED');
        assert.equal(j.limit, 'storage');
        assert.equal(j.upgradeUrl, '/billing');
        assert.match(j.upgrade, /Pro/);
        assert.equal(new errors.QuotaError('max_file_size', 'big', 'anonymous').status, 413);
    });
});

describe('upload enforcement', () => {
    before(() => { process.env.PLAN_FREE_STORAGE_GB = String(1000 / GB); process.env.PLAN_FREE_MAX_FILE_MB = String(600 / MB); });
    after(() => { delete process.env.PLAN_FREE_STORAGE_GB; delete process.env.PLAN_FREE_MAX_FILE_MB; });

    test('file size and storage quota at creation (413 / 402)', async () => {
        const u = await newUser();
        await assert.rejects(enforce.checkUploadQuota({ userId: u, size: 601 }), (e: { status: number; limit: string }) => e.status === 413 && e.limit === 'max_file_size');
        const ok = await enforce.checkUploadQuota({ userId: u, size: 500 });
        assert.equal(ok.plan.id, 'free');
        assert.equal(ok.remainingStorage, 1000);
        assert.equal(ok.maxBytes, 600);
        assert.equal(await usage.reserveStorage(u, 500, 1000), true);
        assert.equal(await usage.reserveStorage(u, 400, 1000), true);
        assert.equal(await usage.reserveStorage(u, 101, 1000), false, 'would exceed: nothing reserved');
        assert.equal((await usage.getStorageUsage(u)).storageBytes, 900);
        await assert.rejects(enforce.checkUploadQuota({ userId: u, size: 200 }), (e: { status: number; limit: string; code: string }) =>
            e.status === 402 && e.limit === 'storage' && e.code === 'STORAGE_QUOTA_EXCEEDED');
        const allowance = await enforce.checkUploadQuota({ userId: u, size: 50 });
        assert.equal(allowance.maxBytes, 100, 'stream limit = remaining storage');
        assert.equal(enforce.oversizeError(allowance, 101).limit, 'storage');
    });

    test('deleting/expiring a file releases its storage', async () => {
        const u = await newUser();
        assert.equal(await usage.reserveStorage(u, 300, 1000), true);
        const rec = await FileRepository.create({
            user_id: u, share_id: `s${randomUUID().slice(0, 10)}`, original_name: 'a', sanitized_name: 'a', storage_path: '/x', file_size: 300,
            mime_type: 'text/plain', expires_at: Date.now() - 1, compression_ratio: null, compression_speed: null, is_encrypted: 0,
        });
        await FileRepository.delete(rec.id);
        assert.equal((await usage.getStorageUsage(u)).storageBytes, 0);
    });

    test('anonymous uploads: per-file anon limits, no storage quota', async () => {
        const a = await enforce.checkUploadQuota({ userId: null, size: 10 });
        assert.equal(a.plan.id, 'anonymous');
        assert.equal(a.remainingStorage, null);
    });

    test('password links can be disabled per plan', withEnv({ PLAN_FREE_PASSWORD_LINKS: 'false' }, async () => {
        const u = await newUser();
        await assert.rejects(enforce.checkUploadQuota({ userId: u, size: 1, hasPassword: true }), (e: { limit: string; status: number }) => e.limit === 'password_links' && e.status === 402);
    }));
});

describe('egress enforcement and batching', () => {
    before(() => {
        kvMod.setKVForTesting(new kvMod.MemoryKV());
        process.env.PLAN_FREE_EGRESS_GB = String(1000 / GB); // 1000-byte monthly allowance
        process.env.CREDITS_PER_GB = '1';
    });
    after(() => { delete process.env.PLAN_FREE_EGRESS_GB; delete process.env.CREDITS_PER_GB; });

    test('within quota -> reserved in the KV batch; flush applies one summed row', async () => {
        const u = await newUser();
        for (let i = 0; i < 5; i++) {
            const g = await enforce.authorizeEgress({ ownerId: u, shareId: 'f1', bytes: 100 });
            assert.equal(g.ok, true);
            assert.equal(g.charged, 0);
        }
        assert.equal(await usage.pendingEgress(u), 500);
        assert.equal((await usage.getMonthlyUsage(u)).egressBytes, 0, 'no DB write per request');
        assert.ok((await usage.flushEgress()) >= 1);
        assert.equal((await usage.getMonthlyUsage(u)).egressBytes, 500);
        assert.equal(await usage.pendingEgress(u), 0);
        assert.equal((await usage.billableEgress(u)).billable, 500);
    });

    test('a cancelled response is corrected to the bytes actually sent', async () => {
        const u = await newUser();
        const g = await enforce.authorizeEgress({ ownerId: u, shareId: 'f2', bytes: 400 });
        const src = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(new Uint8Array(150)); c.enqueue(new Uint8Array(250)); c.close(); },
        });
        let served = -1;
        const reader = enforce.meterBody(src, (n: number) => { served = n; }).getReader();
        await reader.read(); // 150 bytes delivered
        await reader.cancel();
        assert.equal(served, 150);
        await enforce.settleEgress(g, served);
        assert.equal(await usage.pendingEgress(u), 150);
    });

    test('over quota: owner credits pay the overage; without credits the downloader gets 402', async () => {
        const u = await newUser();
        assert.equal((await enforce.authorizeEgress({ ownerId: u, shareId: 'f3', bytes: 1000 })).ok, true, 'exactly the allowance');
        const denied = await enforce.authorizeEgress({ ownerId: u, shareId: 'f3', bytes: GB });
        assert.equal(denied.ok, false);
        assert.equal(denied.error.status, 402);
        assert.equal(denied.error.limit, 'monthly_egress');
        assert.match(denied.error.message, /owner/);

        await credits.grantCredits(u, 2, { type: 'grant', idempotencyKey: `t:${u}` });
        const paid = await enforce.authorizeEgress({ ownerId: u, shareId: 'f3', bytes: GB });
        assert.equal(paid.ok, true);
        assert.equal(paid.charged, 1);
        assert.equal(await credits.getBalance(u), 1);
        const m = await usage.getMonthlyUsage(u);
        assert.equal(m.creditedEgressBytes, GB, 'paid bytes are excluded from the quota');
        const ledger = await credits.listLedger(u);
        assert.equal(ledger[0].type, 'egress');
        assert.equal(ledger[0].amount, -1);
    });

    test('anonymous files have a per-file monthly allowance and no credits', withEnv({ PLAN_ANON_EGRESS_GB: String(100 / GB) }, async () => {
        assert.equal((await enforce.authorizeEgress({ ownerId: null, shareId: 'anonA', bytes: 100 })).ok, true);
        const r = await enforce.authorizeEgress({ ownerId: null, shareId: 'anonA', bytes: 1 });
        assert.equal(r.ok, false);
        assert.equal(r.error.plan, 'anonymous');
        assert.equal((await enforce.authorizeEgress({ ownerId: null, shareId: 'anonB', bytes: 100 })).ok, true, 'other file has its own allowance');
    }));

    test('flush is leader-only (lock held elsewhere -> skipped, data kept)', async () => {
        const kv = kvMod.getKV();
        await usage.recordEgressBytes('lockcheck', 42);
        const lock = await kvMod.acquireLock(usage.EGRESS_FLUSH_LOCK, 5000, kv);
        assert.equal(await usage.flushEgress(kv), null);
        assert.equal(await usage.pendingEgress('lockcheck'), 42);
        await lock.release();
        await usage.flushEgress(kv);
        assert.equal((await usage.getMonthlyUsage('lockcheck')).egressBytes, 42);
    });
});

after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});
