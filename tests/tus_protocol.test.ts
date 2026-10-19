/**
 * tus 1.0.0 server (diocom-app/src/lib/upload/tus): offsets, Upload-Length limits, creation-with-upload,
 * checksum (460), termination, expiration + sweep, interrupted bodies, lock takeover, finalize outcomes.
 * Runs on WHATWG Request/Response objects against a temp staging dir and the in-memory KV.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import {
    TusServer, TusError, TusHooks, parseMetadata, encodeMetadata, TUS_VERSION,
} from '../diocom-app/src/lib/upload/tus/protocol';
import { StagingStore, TusUploadInfo } from '../diocom-app/src/lib/upload/tus/stagingStore';
import { KvLocker } from '../diocom-app/src/lib/upload/tus/locker';
import { MemoryKV } from '../diocom-app/src/lib/kv/memory';

const BASE = 'http://localhost';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface Env {
    dir: string;
    kv: MemoryKV;
    store: StagingStore;
    server: TusServer;
    clock: { now: number };
    completed: Array<{ info: TusUploadInfo; data: Buffer }>;
    hooks: TusHooks & { failNext?: TusError | Error | null };
}

function makeEnv(opts: { maxSize?: number; expiryMs?: number; persistEveryBytes?: number } = {}): Env {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-test-'));
    const kv = new MemoryKV();
    const store = new StagingStore(dir, kv);
    const clock = { now: Date.now() };
    const completed: Env['completed'] = [];
    const hooks: Env['hooks'] = {
        failNext: null,
        async onCreate(_req, input) {
            if (input.metadata.filename === 'reject.exe') throw new TusError(400, 'File type not allowed', { success: false, code: 'INVALID_TYPE' });
            const { password, ...rest } = input.metadata;
            const kept: Record<string, string> = {};
            for (const [k, v] of Object.entries(rest)) if (v !== null) kept[k] = v;
            return { ownerId: null, context: { hasPassword: !!password }, metadata: kept };
        },
        async onComplete(_req, info, dataPath) {
            const f = hooks.failNext;
            if (f) {
                hooks.failNext = null;
                throw f;
            }
            completed.push({ info: { ...info }, data: fs.readFileSync(dataPath) });
            return { headers: { 'Diocom-Share-Link': `${BASE}/v1/share-${info.id.slice(0, 6)}` }, body: { success: true, link: `${BASE}/v1/share-${info.id.slice(0, 6)}` } };
        },
    };
    const server = new TusServer({
        basePath: '/api/uploads',
        store,
        locker: new KvLocker(kv, 3_000),
        hooks,
        maxSize: () => opts.maxSize ?? 1024 * 1024,
        expiryMs: opts.expiryMs ?? 60_000,
        persistEveryBytes: opts.persistEveryBytes,
        lockWaitMs: 3_000,
        now: () => clock.now,
        log: () => undefined,
    });
    return { dir, kv, store, server, clock, completed, hooks };
}

function tusReq(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Request {
    const init: RequestInit & { duplex?: 'half' } = { method, headers: { 'Tus-Resumable': TUS_VERSION, ...headers } };
    if (body !== undefined && body !== null) {
        init.body = body as BodyInit;
        init.duplex = 'half';
    }
    return new Request(BASE + url, init);
}

async function create(env: Env, length: number, metadata: Record<string, string> = { filename: 'a.bin', filetype: 'application/octet-stream' }): Promise<string> {
    const res = await env.server.handle(tusReq('POST', '/api/uploads', { 'Upload-Length': String(length), 'Upload-Metadata': encodeMetadata(metadata) }));
    assert.equal(res.status, 201, await res.clone().text());
    const loc = res.headers.get('location')!;
    assert.match(loc, /^\/api\/uploads\/[A-Za-z0-9_-]{32}$/);
    return loc;
}

function patch(env: Env, url: string, offset: number, body: unknown, extra: Record<string, string> = {}) {
    return env.server.handle(tusReq('PATCH', url, { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset), ...extra }, body));
}

async function head(env: Env, url: string) {
    return env.server.handle(tusReq('HEAD', url));
}

describe('tus protocol server', () => {
    let env: Env;
    beforeEach(() => { env = makeEnv(); });
    afterEach(async () => {
        await env.kv.close();
        fs.rmSync(env.dir, { recursive: true, force: true });
    });

    test('OPTIONS advertises version, extensions, max size and checksum algorithms', async () => {
        const res = await env.server.handle(new Request(`${BASE}/api/uploads`, { method: 'OPTIONS' }));
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('tus-version'), '1.0.0');
        assert.equal(res.headers.get('tus-extension'), 'creation,creation-with-upload,termination,expiration,checksum');
        assert.equal(res.headers.get('tus-max-size'), String(1024 * 1024));
        assert.match(res.headers.get('tus-checksum-algorithm')!, /sha256/);
    });

    test('requests without Tus-Resumable: 1.0.0 get 412', async () => {
        const res = await env.server.handle(new Request(`${BASE}/api/uploads`, { method: 'POST', headers: { 'Upload-Length': '10' } }));
        assert.equal(res.status, 412);
        assert.equal(res.headers.get('tus-version'), '1.0.0');
    });

    test('metadata codec round-trips and rejects malformed headers', () => {
        const enc = encodeMetadata({ filename: 'résumé.pdf', is_encrypted: 'true' });
        assert.deepEqual({ ...parseMetadata(enc) }, { filename: 'résumé.pdf', is_encrypted: 'true' });
        assert.deepEqual({ ...parseMetadata('flag,name YQ==') }, { flag: null, name: 'a' });
        assert.throws(() => parseMetadata('name %%%'), TusError);
        assert.throws(() => parseMetadata('a YQ==,a Yg=='), TusError);
    });

    test('creation: 201 + Location + Upload-Expires; HEAD echoes length/offset/metadata but never the password', async () => {
        const url = await create(env, 100, { filename: 'a.txt', filetype: 'text/plain', password: 'hunter2' });
        const res = await head(env, url);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('upload-offset'), '0');
        assert.equal(res.headers.get('upload-length'), '100');
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.ok(res.headers.get('upload-expires'));
        const meta = parseMetadata(res.headers.get('upload-metadata'));
        assert.equal(meta.filename, 'a.txt');
        assert.equal(meta.password, undefined);
        assert.ok(!fs.readFileSync(path.join(env.dir, `${url.split('/').pop()}.json`), 'utf8').includes('hunter2'));
    });

    test('Upload-Length limits: missing -> 400, above Tus-Max-Size -> 413, defer-length -> 400; hook rejection passes through', async () => {
        let res = await env.server.handle(tusReq('POST', '/api/uploads'));
        assert.equal(res.status, 400);
        res = await env.server.handle(tusReq('POST', '/api/uploads', { 'Upload-Length': String(1024 * 1024 + 1) }));
        assert.equal(res.status, 413);
        assert.equal((await res.json()).code, 'FILE_TOO_LARGE');
        res = await env.server.handle(tusReq('POST', '/api/uploads', { 'Upload-Defer-Length': '1' }));
        assert.equal(res.status, 400);
        res = await env.server.handle(tusReq('POST', '/api/uploads', { 'Upload-Length': '5', 'Upload-Metadata': encodeMetadata({ filename: 'reject.exe' }) }));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, 'INVALID_TYPE');
        assert.equal(fs.readdirSync(env.dir).length, 0, 'nothing staged for rejected creations');
    });

    test('offset handling: chunks append, wrong offsets get 409, completion finalizes with the exact bytes', async () => {
        const data = randomBytes(300_000);
        const url = await create(env, data.length);
        let res = await patch(env, url, 0, data.subarray(0, 100_000));
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('upload-offset'), '100000');
        assert.ok(res.headers.get('upload-expires'));

        res = await patch(env, url, 0, data.subarray(0, 10)); // stale offset
        assert.equal(res.status, 409);
        assert.equal(res.headers.get('upload-offset'), '100000');
        res = await patch(env, url, 150_000, data.subarray(150_000, 150_010)); // gap
        assert.equal(res.status, 409);

        res = await env.server.handle(tusReq('PATCH', url, { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '100000' }, data.subarray(100_000)));
        assert.equal(res.status, 415);
        res = await env.server.handle(tusReq('PATCH', url, { 'Content-Type': 'application/offset+octet-stream' }, data.subarray(100_000)));
        assert.equal(res.status, 400, 'Upload-Offset required');

        assert.equal((await head(env, url)).headers.get('upload-offset'), '100000');
        res = await patch(env, url, 100_000, data.subarray(100_000));
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('upload-offset'), '300000');
        assert.equal(res.headers.get('diocom-upload-state'), 'done');
        assert.match(res.headers.get('diocom-share-link')!, /\/v1\/share-/);
        assert.equal(env.completed.length, 1);
        assert.equal(sha256(env.completed[0].data), sha256(data));

        // Data file is gone, the result stays readable.
        assert.equal(await env.store.dataSize(url.split('/').pop()!), null);
        const h = await head(env, url);
        assert.equal(h.headers.get('upload-offset'), '300000');
        assert.equal(h.headers.get('diocom-share-link'), res.headers.get('diocom-share-link'));
        const g = await env.server.handle(new Request(BASE + url));
        assert.equal(g.status, 200);
        assert.equal((await g.json()).success, true);
        // A repeated final PATCH (lost response) is answered idempotently.
        res = await patch(env, url, 300_000, new Uint8Array(0));
        assert.equal(res.status, 204);
        assert.equal(env.completed.length, 1);
    });

    test('received bytes beyond Upload-Length are refused with 413 and discarded', async () => {
        const url = await create(env, 1000);
        let res = await patch(env, url, 0, randomBytes(1001), { 'Content-Length': '1001' });
        assert.equal(res.status, 413, 'declared Content-Length over the remaining length');
        // Undeclared length (chunked body): detected while streaming.
        const body = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(randomBytes(600)); c.enqueue(randomBytes(600)); c.close(); },
        });
        res = await patch(env, url, 0, body);
        assert.equal(res.status, 413);
        assert.equal((await head(env, url)).headers.get('upload-offset'), '0');
        assert.equal(await env.store.dataSize(url.split('/').pop()!), 0);
    });

    test('checksum: sha256 match accepted, mismatch -> 460 with the chunk discarded, unknown algorithm -> 400', async () => {
        const data = randomBytes(5000);
        const url = await create(env, data.length);
        const sum = (b: Uint8Array, alg = 'sha256') => `${alg} ${createHash(alg).update(b).digest('base64')}`;
        let res = await patch(env, url, 0, data.subarray(0, 2000), { 'Upload-Checksum': sum(data.subarray(0, 2000)) });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('upload-offset'), '2000');

        res = await patch(env, url, 2000, data.subarray(2000), { 'Upload-Checksum': sum(randomBytes(10)) });
        assert.equal(res.status, 460);
        assert.equal((await head(env, url)).headers.get('upload-offset'), '2000');
        assert.equal(await env.store.dataSize(url.split('/').pop()!), 2000, 'mismatching chunk truncated away');

        res = await patch(env, url, 2000, data.subarray(2000), { 'Upload-Checksum': `crc32 AAAAAA==` });
        assert.equal(res.status, 400);
        res = await patch(env, url, 2000, data.subarray(2000), { 'Upload-Checksum': sum(data.subarray(2000), 'sha1') });
        assert.equal(res.status, 204);
        assert.equal(sha256(env.completed[0].data), sha256(data));
    });

    test('creation-with-upload: POST carries the first bytes (or the whole file)', async () => {
        const data = randomBytes(4096);
        let res = await env.server.handle(tusReq('POST', '/api/uploads', {
            'Upload-Length': String(data.length), 'Content-Type': 'application/offset+octet-stream',
        }, data.subarray(0, 1000)));
        assert.equal(res.status, 201);
        assert.equal(res.headers.get('upload-offset'), '1000');
        const url = res.headers.get('location')!;
        res = await patch(env, url, 1000, data.subarray(1000));
        assert.equal(res.headers.get('diocom-upload-state'), 'done');

        res = await env.server.handle(tusReq('POST', '/api/uploads', {
            'Upload-Length': String(data.length), 'Content-Type': 'application/offset+octet-stream',
        }, data));
        assert.equal(res.status, 201);
        assert.equal(res.headers.get('upload-offset'), String(data.length));
        assert.equal(res.headers.get('diocom-upload-state'), 'done');
        assert.equal(env.completed.length, 2);
    });

    test('termination: DELETE removes the upload and its staging files', async () => {
        const url = await create(env, 1000);
        await patch(env, url, 0, randomBytes(10));
        const res = await env.server.handle(tusReq('DELETE', url));
        assert.equal(res.status, 204);
        assert.equal((await head(env, url)).status, 404);
        assert.equal((await patch(env, url, 10, randomBytes(10))).status, 404);
        assert.deepEqual(fs.readdirSync(env.dir), []);
    });

    test('expiration: idle uploads expire (410), PATCH refreshes Upload-Expires, the sweep deletes expired uploads', async () => {
        const a = await create(env, 1000);
        const b = await create(env, 1000);
        env.clock.now += 50_000;
        await patch(env, b, 0, randomBytes(10)); // activity refreshes b's expiry
        env.clock.now += 20_000; // a: 70 s idle (> 60 s), b: 20 s idle
        assert.equal((await head(env, a)).status, 410);
        assert.equal((await patch(env, a, 0, randomBytes(10))).status, 410);
        assert.equal((await head(env, b)).status, 200);

        const r = await env.server.sweepExpired();
        assert.equal(r.removed, 1);
        assert.equal((await head(env, a)).status, 404);
        assert.ok(!fs.existsSync(path.join(env.dir, `${a.split('/').pop()}.bin`)));
        assert.ok(fs.existsSync(path.join(env.dir, `${b.split('/').pop()}.bin`)));
    });

    test('an interrupted body keeps the received bytes (no checksum) and the upload resumes from there', async () => {
        const data = randomBytes(200_000);
        const url = await create(env, data.length);
        let sent = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(c) {
                if (sent >= 120_000) { c.error(new Error('connection reset')); return; }
                c.enqueue(data.subarray(sent, sent + 40_000));
                sent += 40_000;
            },
        });
        const res = await patch(env, url, 0, body);
        assert.equal(res.status, 400);
        const offset = Number((await head(env, url)).headers.get('upload-offset'));
        assert.equal(offset, 120_000);
        const done = await patch(env, url, offset, data.subarray(offset));
        assert.equal(done.headers.get('diocom-upload-state'), 'done');
        assert.equal(sha256(env.completed[0].data), sha256(data));
    });

    test('the record survives a KV loss (durable sidecar) and an offset is re-read from it', async () => {
        const url = await create(env, 100);
        await patch(env, url, 0, randomBytes(40));
        await env.kv.del(`tus:info:${url.split('/').pop()}`);
        assert.equal((await head(env, url)).headers.get('upload-offset'), '40');
    });

    test('lock takeover: a resumed PATCH stops a stalled one, which persists its offset first', async () => {
        await env.kv.close();
        fs.rmSync(env.dir, { recursive: true, force: true });
        env = makeEnv({ persistEveryBytes: 1 << 30 });
        const data = randomBytes(100_000);
        const url = await create(env, data.length);
        // A body that delivers 30 000 bytes and then hangs (dead connection the server has not noticed yet).
        const stalled = new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(data.subarray(0, 30_000)); },
        });
        const first = patch(env, url, 0, stalled);
        await sleep(100);
        // The client reconnects with a stale view (offset 0): the takeover happens, then 409 reveals the offset.
        const second = await patch(env, url, 0, data.subarray(0, 10));
        const firstRes = await first;
        assert.equal(firstRes.status, 423);
        assert.equal(second.status, 409);
        assert.equal(second.headers.get('upload-offset'), '30000');
        const done = await patch(env, url, 30_000, data.subarray(30_000));
        assert.equal(done.headers.get('diocom-upload-state'), 'done');
        assert.equal(sha256(env.completed[0].data), sha256(data));
    });

    test('finalize failure: retryable keeps the bytes and GET retries; permanent failure is reported and cleaned up', async () => {
        const data = randomBytes(1000);
        let url = await create(env, data.length);
        env.hooks.failNext = new TusError(503, 'store down', { success: false, code: 'STORAGE_UNAVAILABLE' }, { 'Retry-After': '30' }, true);
        let res = await patch(env, url, 0, data);
        assert.equal(res.status, 204);
        assert.equal(res.headers.get('diocom-upload-state'), 'complete');
        assert.equal(res.headers.get('diocom-share-link'), null);
        assert.equal((await head(env, url)).headers.get('upload-offset'), '1000');
        res = await env.server.handle(new Request(BASE + url)); // retry succeeds now
        assert.equal(res.status, 200);
        assert.equal((await res.json()).success, true);
        assert.equal(sha256(env.completed[0].data), sha256(data));

        url = await create(env, data.length);
        env.hooks.failNext = new TusError(400, 'File is empty', { success: false, code: 'FILE_EMPTY' });
        res = await patch(env, url, 0, data);
        assert.equal(res.headers.get('diocom-upload-state'), 'failed');
        res = await env.server.handle(new Request(BASE + url));
        assert.equal(res.status, 400);
        assert.equal((await res.json()).code, 'FILE_EMPTY');
        assert.equal(await env.store.dataSize(url.split('/').pop()!), null);
    });

    test('X-HTTP-Method-Override and unknown ids', async () => {
        const url = await create(env, 10);
        const res = await env.server.handle(tusReq('POST', url, {
            'X-HTTP-Method-Override': 'PATCH', 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0',
        }, randomBytes(10)));
        assert.equal(res.status, 204);
        assert.equal((await head(env, '/api/uploads/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).status, 404);
        assert.equal((await head(env, '/api/uploads/../../etc')).status, 404);
    });
});
