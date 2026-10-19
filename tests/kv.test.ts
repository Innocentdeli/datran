/**
 * Shared KV (diocom-app/src/lib/kv): one contract suite run against both backends.
 *  - MemoryKV always.
 *  - RedisKV against a throwaway `redis:7` container on a random local port (needs Docker), or against
 *    TEST_REDIS_URL if set. Without either, the Redis suite is skipped with a message.
 * The Redis suite uses TWO independent clients ("instance A" and "instance B") to show cross-instance semantics.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import { MemoryKV, RedisKV, KV, acquireLock, withLock, lockHolder } from '../diocom-app/src/lib/kv';
import { joinSwarm, getPeer, authenticatePeer, sendSignal, drainSignals, livePeersInSwarm, MAX_MESSAGES_PER_MAILBOX } from '../diocom-app/src/lib/swarmSignaling';
import { createProgressReporter, subscribeProgress, lastProgress, ProgressEvent } from '../diocom-app/src/lib/uploadProgress';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let uniq = 0;
const k = (name: string) => `t${process.pid}:${Date.now()}:${uniq++}:${name}`;

function contract(name: string, make: () => { a: KV; b: KV } | null, skipReason: () => string | false) {
    describe(name, () => {
        let a: KV;
        let b: KV;
        before(() => {
            const kvs = make();
            if (kvs) ({ a, b } = kvs);
        });
        const t = (title: string, fn: () => Promise<void>) =>
            test(title, async (ctx) => {
                const reason = skipReason();
                if (reason) {
                    ctx.skip(reason);
                    return;
                }
                await fn();
            });

        t('get/set with TTL, setNX, del', async () => {
            const key = k('s');
            assert.equal(await a.get(key), null);
            await a.set(key, 'v1', 150);
            assert.equal(await b.get(key), 'v1');
            assert.equal(await b.setNX(key, 'v2', 1000), false);
            await sleep(250);
            assert.equal(await b.get(key), null, 'expired');
            assert.equal(await b.setNX(key, 'v2', 1000), true);
            await a.del(key);
            assert.equal(await b.get(key), null);
        });

        t('getdel is single-use under concurrency (across clients)', async () => {
            const key = k('tok');
            await a.set(key, 'user-1', 5000);
            const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).getdel(key)));
            assert.deepEqual(results.filter((r) => r !== null), ['user-1']);
            assert.equal(await a.get(key), null);
        });

        t('hash counters: concurrent hIncrBy across clients, negative adjust, atomic drain', async () => {
            const key = k('h');
            await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2 ? a : b).hIncrBy(key, 'u1|2026-10', 100, 5000)));
            await a.hIncrBy(key, 'u2|2026-10', 7, 5000);
            assert.equal(await b.hGet(key, 'u1|2026-10'), 5000);
            assert.equal(await b.hIncrBy(key, 'u1|2026-10', -1000, 5000), 4000);
            assert.equal(await a.hGet(key, 'missing'), 0);
            const drains = await Promise.all([a.hDrain(key), b.hDrain(key)]);
            const merged = drains.find((d) => Object.keys(d).length > 0) ?? {};
            assert.deepEqual(merged, { 'u1|2026-10': 4000, 'u2|2026-10': 7 });
            assert.ok(drains.some((d) => Object.keys(d).length === 0), 'only one drain sees the data');
            assert.equal(await a.hGet(key, 'u1|2026-10'), 0);
        });

        t('delIfEquals / pexpireIfEquals only act for the owner value', async () => {
            const key = k('own');
            await a.set(key, 'owner', 200);
            assert.equal(await b.delIfEquals(key, 'other'), false);
            assert.equal(await b.pexpireIfEquals(key, 'other', 5000), false);
            assert.equal(await b.pexpireIfEquals(key, 'owner', 5000), true);
            await sleep(300);
            assert.equal(await a.get(key), 'owner', 'TTL extended');
            assert.equal(await b.delIfEquals(key, 'owner'), true);
            assert.equal(await a.get(key), null);
        });

        t('sliding window: exact limit under concurrency, shared across clients, frees up after window', async () => {
            const key = k('rl');
            const res = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).slidingWindow(key, 5, 400)));
            assert.equal(res.filter((r) => r.allowed).length, 5);
            const denied = res.find((r) => !r.allowed)!;
            assert.ok(denied.retryAfterMs > 0 && denied.retryAfterMs <= 400, `retryAfter ${denied.retryAfterMs}`);
            assert.equal(denied.remaining, 0);
            await sleep(450);
            const again = await a.slidingWindow(key, 5, 400);
            assert.equal(again.allowed, true);
            assert.equal(again.count, 1);
        });

        t('sliding window is a true sliding log (no fixed-window burst at the boundary)', async () => {
            const key = k('rl2');
            for (let i = 0; i < 3; i++) assert.equal((await a.slidingWindow(key, 3, 600)).allowed, true);
            await sleep(350);
            // A fixed window that started at the first request would still be closed; so is a sliding one.
            assert.equal((await b.slidingWindow(key, 3, 600)).allowed, false);
            await sleep(350); // first three now older than 600 ms
            assert.equal((await b.slidingWindow(key, 3, 600)).allowed, true);
        });

        t('incrCapped never exceeds the cap under concurrency', async () => {
            const key = k('cap');
            const grants = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).incrCapped(key, 30, 100, 5000)));
            assert.equal(grants.reduce((x, y) => x + y, 0), 100);
            assert.equal(await a.incrCapped(key, 1, 100, 5000), 0);
            assert.equal(await a.get(key), '100');
        });

        t('bounded list: push caps length, drain is atomic and single-delivery', async () => {
            const key = k('mb');
            for (let i = 0; i < 8; i++) await (i % 2 ? a : b).listPush(key, `m${i}`, 5, 5000);
            const [d1, d2] = await Promise.all([a.listDrain(key), b.listDrain(key)]);
            const got = [...d1, ...d2];
            assert.deepEqual(got, ['m3', 'm4', 'm5', 'm6', 'm7'], 'oldest dropped, each delivered once');
            assert.ok(d1.length === 0 || d2.length === 0);
            await a.listPush(key, 'x', 5, 100);
            await sleep(200);
            assert.deepEqual(await b.listDrain(key), [], 'list TTL');
        });

        t('zAddCapped: cap, refresh of existing members, pruning of stale ones', async () => {
            const key = k('z');
            const now = Date.now();
            assert.equal(await a.zAddCapped(key, 'p1', now, now - 1000, 2, 5000), true);
            assert.equal(await b.zAddCapped(key, 'p2', now, now - 1000, 2, 5000), true);
            assert.equal(await a.zAddCapped(key, 'p3', now, now - 1000, 2, 5000), false, 'full');
            assert.equal(await a.zAddCapped(key, 'p1', now + 1, now - 1000, 2, 5000), true, 'existing refreshed when full');
            // p2 becomes stale relative to a later minScore -> pruned, p3 fits
            assert.equal(await b.zAddCapped(key, 'p3', now + 2000, now + 1, 2, 5000), true);
            assert.deepEqual((await a.zMembers(key, now + 1)).sort(), ['p1', 'p3']);
            await a.zRem(key, 'p1');
            assert.deepEqual(await b.zMembers(key, 0), ['p3']);
        });

        t('pub/sub delivers across clients; unsubscribe stops delivery', async () => {
            const ch = k('ch');
            const got: string[] = [];
            const unsub = await b.subscribe(ch, (m) => got.push(m));
            await a.publish(ch, 'hello');
            await a.publish(ch, 'world');
            for (let i = 0; i < 50 && got.length < 2; i++) await sleep(10);
            assert.deepEqual(got, ['hello', 'world']);
            await unsub();
            await a.publish(ch, 'late');
            await sleep(100);
            assert.deepEqual(got, ['hello', 'world']);
        });

        t('distributed lock: exclusive, owner-only release, expiry', async () => {
            const name = k('lock');
            const l1 = await acquireLock(name, 300, a);
            assert.ok(l1);
            assert.equal(await acquireLock(name, 300, b), null, 'held');
            assert.equal(await b.delIfEquals(`lock:${name}`, 'forged'), false);
            await sleep(400);
            const l2 = await acquireLock(name, 300, b);
            assert.ok(l2, 'expired lease can be taken over');
            assert.equal(await l1!.release(), false, 'stale holder cannot release the new lease');
            assert.equal(await lockHolder(name, a), l2!.token);
            assert.equal(await l2!.release(), true);
        });

        t('withLock: concurrent runs on two clients -> exactly one executes; lease renewed past TTL', async () => {
            const name = k('job');
            let running = 0;
            let maxRunning = 0;
            const job = async () => {
                running++;
                maxRunning = Math.max(maxRunning, running);
                await sleep(500); // longer than the 200 ms lease: must be renewed
                running--;
                return 'done';
            };
            const results = await Promise.all([
                withLock(name, 200, job, a), withLock(name, 200, job, b),
                withLock(name, 200, job, a), withLock(name, 200, job, b),
            ]);
            assert.equal(results.filter((r) => r.acquired).length, 1);
            assert.equal(maxRunning, 1);
            assert.equal(await lockHolder(name, a), null, 'released after the run');
        });

        t('swarm signaling: join on A, signal via B, drain via A; secrets and caps hold', async () => {
            const share = k('share').replace(/[^A-Za-z0-9_-]/g, '_');
            const p1 = `p1${uniq}`;
            const p2 = `p2${uniq}`;
            const j1 = await joinSwarm(p1, share, a);
            assert.ok(j1.ok);
            assert.deepEqual((await joinSwarm(p1, share, b)), { ok: false, reason: 'in_use' }, 'id claimed atomically');
            const j2 = await joinSwarm(p2, share, b);
            assert.ok(j2.ok && j2.peers.includes(p1));
            const rec = await getPeer(p1, b);
            assert.ok(authenticatePeer(rec, j1.ok ? j1.token : ''));
            assert.equal(authenticatePeer(rec, 'wrong-token'), false);
            assert.deepEqual((await livePeersInSwarm(share, a)).sort(), [p1, p2].sort());
            for (let i = 0; i < MAX_MESSAGES_PER_MAILBOX + 5; i++) await sendSignal(p2, p1, { n: i }, b);
            const msgs = await drainSignals(p1, a);
            assert.equal(msgs.length, MAX_MESSAGES_PER_MAILBOX, 'mailbox bounded');
            assert.equal(msgs[0].from, p2);
            assert.deepEqual(msgs[msgs.length - 1].signal, { n: MAX_MESSAGES_PER_MAILBOX + 4 });
            assert.deepEqual(await drainSignals(p1, b), [], 'delivered once');
        });

        t('upload progress: reporter on A, subscriber on B sees events in order and the final state', async () => {
            const id = `u${Date.now()}${uniq++}abcdefghijkl`;
            const seen: ProgressEvent[] = [];
            const unsub = await subscribeProgress(id, (e) => seen.push(e), b);
            const rep = createProgressReporter(id, 1000, a);
            const counter = rep.counter();
            counter.resume();
            counter.write(Buffer.alloc(400));
            await sleep(300);
            counter.write(Buffer.alloc(600));
            counter.end();
            rep.processing();
            await rep.done();
            for (let i = 0; i < 50 && !seen.some((e) => e.phase === 'done'); i++) await sleep(10);
            await unsub();
            assert.deepEqual(seen.map((e) => e.phase), ['uploading', 'uploading', 'processing', 'done']);
            assert.equal(seen[0].received, 400);
            assert.equal(seen[1].percent, 100);
            assert.equal((await lastProgress(id, b))?.phase, 'done');
        });
    });
}

// ---- backends --------------------------------------------------------------------------------------------------

const memory = new MemoryKV();
contract('MemoryKV', () => ({ a: memory, b: memory }), () => false);

let redisUrl = process.env.TEST_REDIS_URL || '';
let container = '';
let redisSkip: string | false = false;
let ra: RedisKV | null = null;
let rb: RedisKV | null = null;

function startRedisContainer(): string | false {
    if (redisUrl) return false;
    try {
        execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'pipe', timeout: 15_000 });
    } catch {
        return 'Docker not available and TEST_REDIS_URL not set: skipping Redis-backed KV tests';
    }
    try {
        container = execFileSync('docker', ['run', '-d', '--rm', '-p', '127.0.0.1::6379', 'redis:7', 'redis-server', '--save', '', '--appendonly', 'no'],
            { stdio: 'pipe', timeout: 180_000 }).toString().trim();
        const port = execFileSync('docker', ['port', container, '6379/tcp'], { stdio: 'pipe' }).toString().trim().split('\n')[0].split(':').pop();
        redisUrl = `redis://127.0.0.1:${port}`;
        return false;
    } catch (e) {
        return `Could not start redis:7 container (${e instanceof Error ? e.message.split('\n')[0] : e}): skipping Redis-backed KV tests`;
    }
}

describe('RedisKV setup', () => {
    before(async () => {
        redisSkip = startRedisContainer();
        if (redisSkip) {
            console.log(`# ${redisSkip}`);
            return;
        }
        const prefix = `kvtest${process.pid}:`;
        ra = new RedisKV(redisUrl, { prefix });
        rb = new RedisKV(redisUrl, { prefix });
        // wait for the container to accept connections
        for (let i = 0; i < 50; i++) {
            try {
                await ra.set('ping', '1', 1000);
                break;
            } catch {
                await sleep(200);
            }
        }
        console.log(`# Redis-backed KV tests running against ${redisUrl}`);
    });
    test('redis reachable (or skipped)', async () => {
        if (redisSkip) return;
        assert.equal(await ra!.get('ping'), '1');
    });
});

contract('RedisKV (two clients = two instances)', () => (ra && rb ? { a: ra, b: rb } : null), () => redisSkip);

after(async () => {
    await memory.close();
    await ra?.close();
    await rb?.close();
    if (container) {
        try {
            execFileSync('docker', ['rm', '-f', container], { stdio: 'pipe' });
        } catch { /* ignore */ }
    }
});
