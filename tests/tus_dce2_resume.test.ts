/**
 * Resumable E2E uploads: the on-the-fly DCE2 source (diocom-app/src/lib/upload/dce2Source.ts) regenerates identical
 * ciphertext for any byte range, and a tus-js-client upload interrupted midway resumes from a NEW client instance
 * (simulated page reload: only the URL storage, the resume record and the sealed key survive) and decrypts correctly.
 * The tus server runs in-process behind node:http.
 */
import { test, describe, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { importMasterKey, encryptBytes, decryptBytes, encryptedSize } from '../diocom-app/src/lib/crypto/dce2';
import { openDce2Source, newDce2Params, paramsToJson, paramsFromJson } from '../diocom-app/src/lib/upload/dce2Source';
import { uploadDce2Resumable, webCryptoVault, Dce2ResumeRecord, ResumeRecordStore } from '../diocom-app/src/lib/upload/resumableUpload';
import { MemoryUrlStorage, tusUpload } from '../diocom-app/src/lib/upload/tusClient';
import { TusServer } from '../diocom-app/src/lib/upload/tus/protocol';
import { StagingStore } from '../diocom-app/src/lib/upload/tus/stagingStore';
import { KvLocker } from '../diocom-app/src/lib/upload/tus/locker';
import { MemoryKV } from '../diocom-app/src/lib/kv/memory';

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const blobOf = (b: Uint8Array) => ({ size: b.length, slice: (s: number, e: number) => ({ arrayBuffer: async () => new Uint8Array(b.subarray(s, e)).buffer as ArrayBuffer }) });
const keyStr = () => randomBytes(32).toString('base64url');

describe('DCE2 random-access source', () => {
    test('any range equals the same range of the one-shot ciphertext', async () => {
        const plain = new Uint8Array(randomBytes(10_000 + 123));
        const k = keyStr();
        const master = await importMasterKey(k);
        const params = newDce2Params(1024);
        const full = await encryptBytes(master, plain, { chunkSize: 1024, salt: params.salt, noncePrefix: params.noncePrefix });
        const src = await openDce2Source(master, blobOf(plain), paramsFromJson(paramsToJson(params)));
        assert.equal(src.size, full.length);
        assert.equal(src.size, encryptedSize(plain.length, 1024));
        for (const [s, e] of [[0, 44], [0, 10], [40, 2000], [1063, 1064], [5000, src.size], [src.size - 1, src.size], [0, src.size]]) {
            assert.deepEqual(Buffer.from(await src.read(s, e)), Buffer.from(full.subarray(s, e)), `range ${s}-${e}`);
        }
        // Arbitrary tus chunking reassembles to the same bytes and decrypts.
        const parts: Uint8Array[] = [];
        for (let off = 0; off < src.size; off += 777) parts.push(await src.read(off, off + 777));
        const joined = Buffer.concat(parts);
        assert.equal(sha256(joined), sha256(full));
        assert.equal(sha256(await decryptBytes(master, joined)), sha256(plain));
    });
});

describe('tus-js-client resume of an encrypted upload (in-process server)', () => {
    let server: http.Server;
    let endpoint: string;
    let dir: string;
    let kv: MemoryKV;
    const completed = new Map<string, Buffer>();

    before(async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tus-e2e-'));
        kv = new MemoryKV();
        const tusServer = new TusServer({
            basePath: '/api/uploads',
            store: new StagingStore(dir, kv),
            locker: new KvLocker(kv, 3_000),
            maxSize: () => 64 * 1024 * 1024,
            expiryMs: 60_000,
            log: () => undefined,
            hooks: {
                async onCreate(_req, input) {
                    const kept: Record<string, string> = {};
                    for (const [k, v] of Object.entries(input.metadata)) if (v !== null && k !== 'password') kept[k] = v;
                    return { ownerId: null, context: {}, metadata: kept };
                },
                async onComplete(_req, info, dataPath) {
                    const id = `s${completed.size}`;
                    completed.set(id, fs.readFileSync(dataPath));
                    return { headers: { 'Diocom-Share-Link': `http://x/v1/${id}` }, body: { success: true, link: `http://x/v1/${id}` } };
                },
            },
        });
        server = http.createServer(async (req, res) => {
            const headers = new Headers();
            for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
            const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
            const ac = new AbortController();
            req.on('close', () => { if (!req.complete) ac.abort(); });
            const request = new Request(`http://127.0.0.1${req.url}`, {
                method: req.method, headers, signal: ac.signal,
                body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
                duplex: 'half',
            } as RequestInit);
            const response = await tusServer.handle(request);
            res.writeHead(response.status, Object.fromEntries(response.headers));
            res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/uploads`;
    });

    after(async () => {
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
        await kv.close();
        fs.rmSync(dir, { recursive: true, force: true });
    });

    test('plaintext upload with Buffer source', async () => {
        const data = randomBytes(300_000);
        const out = await tusUpload({ endpoint, source: data, size: data.length, metadata: { filename: 'p.bin' }, fingerprint: 'plain-1', chunkSize: 100_000, urlStorage: new MemoryUrlStorage(), retryDelays: [] });
        assert.equal(out.status, 200);
        assert.equal(sha256(completed.get(out.data!.link!.split('/').pop()!)!), sha256(data));
    });

    test('abort midway, "reload" (new client, new batch key), resume: identical ciphertext, decrypts, key never stored in clear', async () => {
        const plain = randomBytes(3 * 1024 * 1024 + 4321);
        const originalKey = keyStr();
        // Durable browser state that survives a reload: URL storage + resume records (localStorage), vault key (IndexedDB).
        const urlStorage = new MemoryUrlStorage();
        const recMap = new Map<string, string>();
        const records: ResumeRecordStore = {
            get: async (fp) => (recMap.has(fp) ? JSON.parse(recMap.get(fp)!) as Dce2ResumeRecord : null),
            set: async (fp, rec) => { recMap.set(fp, JSON.stringify(rec)); },
            remove: async (fp) => { recMap.delete(fp); },
        };
        const wrapKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const vault = webCryptoVault(async () => wrapKey);
        const common = {
            file: blobOf(plain), fileFingerprint: 'f.bin|3149049', metadata: { filename: 'f.bin', filetype: 'application/octet-stream', password: 'pw' },
            records, vault, urlStorage, endpoint, chunkSize: 512 * 1024, dce2ChunkSize: 64 * 1024, retryDelays: [] as number[],
            wrap: (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength),
        };

        const ac = new AbortController();
        let sentFirst = 0;
        await assert.rejects(uploadDce2Resumable({
            ...common, keyStr: originalKey, signal: ac.signal,
            onProgress: (sent) => { sentFirst = sent; if (sent > 1_200_000) ac.abort(); },
        }));
        assert.ok(sentFirst > 1_200_000);
        const stored = [...recMap.values()].join() + JSON.stringify([...urlStorage.entries.values()]);
        assert.ok(!stored.includes(originalKey), 'link key never persisted in readable form');
        assert.ok(!stored.includes('"password"'), 'password never persisted');
        await new Promise((r) => setTimeout(r, 300)); // let the server persist the aborted PATCH

        const out = await uploadDce2Resumable({ ...common, keyStr: keyStr() /* the reloaded page has a new batch key */ });
        assert.equal(out.status, 200);
        assert.ok(out.resumedFrom && out.resumedFrom > 0, `resumed from ${out.resumedFrom}`);
        assert.equal(out.keyStr, originalKey, 'the sealed key was recovered');
        const cipher = completed.get(out.data!.link!.split('/').pop()!)!;
        assert.equal(cipher.length, encryptedSize(plain.length, 64 * 1024));
        const decrypted = await decryptBytes(await importMasterKey(out.keyStr), cipher);
        assert.equal(sha256(decrypted), sha256(plain));
        assert.equal(recMap.size, 0, 'resume record removed on success');
        assert.equal(urlStorage.entries.size, 0, 'tus URL removed on success');
    });
});
