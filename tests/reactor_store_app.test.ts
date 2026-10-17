/**
 * Unit tests for the web app's reactor object store integration (diocom-app/src/lib/storage/reactorStoreCore.ts —
 * pure module): backend selection, storage path parsing, Range forwarding, response header mapping, access counting,
 * PUT result validation and ratio formatting (NETWORK_SPEC §2).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import {
    resolveStorageBackend, toReactorStoragePath, parseReactorStoragePath, isReactorStoragePath, forwardableRange,
    mapReactorResponse, isCountedAccess, parseStorePutResult, formatStoreRatio, storeFullMessage,
} from '../diocom-app/src/lib/storage/reactorStoreCore';

const ID = 'a'.repeat(64);
const hdrs = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
const APP = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
};

describe('storage backend selection', () => {
    test('explicit STORAGE_BACKEND wins, case-insensitive', () => {
        assert.equal(resolveStorageBackend({ STORAGE_BACKEND: 'reactor' }), 'reactor');
        assert.equal(resolveStorageBackend({ STORAGE_BACKEND: ' Local ', CDN_ENABLED: 'true' }), 'local');
        assert.equal(resolveStorageBackend({ STORAGE_BACKEND: 'S3' }), 's3');
    });
    test('unset/invalid keeps the legacy CDN_ENABLED rule (default local)', () => {
        assert.equal(resolveStorageBackend({}), 'local');
        assert.equal(resolveStorageBackend({ CDN_ENABLED: 'true' }), 's3');
        assert.equal(resolveStorageBackend({ STORAGE_BACKEND: 'ftp' }), 'local');
    });
});

describe('reactor storage paths', () => {
    test('round trip, lowercased', () => {
        const p = toReactorStoragePath(ID.toUpperCase());
        assert.equal(p, `reactor:${ID}`);
        assert.equal(parseReactorStoragePath(p), ID);
        assert.equal(parseReactorStoragePath(`reactor:${ID.toUpperCase()}`), ID);
        assert.ok(isReactorStoragePath(p));
    });
    test('legacy paths, URLs and malformed ids are not reactor paths', () => {
        for (const p of ['C:\\data\\.storage\\abc', '/srv/.storage/x', 'https://b.s3.amazonaws.com/k', `reactor:${ID}x`,
            'reactor:../../etc', `reactor:${'g'.repeat(64)}`, 'reactor:', '', null, undefined, 42]) {
            assert.equal(parseReactorStoragePath(p), null, String(p));
        }
    });
    test('toReactorStoragePath rejects invalid ids', () => {
        assert.throws(() => toReactorStoragePath('abc'));
        assert.throws(() => toReactorStoragePath('../' + ID));
    });
});

describe('Range forwarding', () => {
    test('plausible byte ranges are forwarded verbatim (reactor applies RFC 9110 rules)', () => {
        assert.equal(forwardableRange('bytes=0-99'), 'bytes=0-99');
        assert.equal(forwardableRange('bytes=-500'), 'bytes=-500');
        assert.equal(forwardableRange(' bytes=100- '), 'bytes=100-');
        assert.equal(forwardableRange('bytes=0-1,5-9'), 'bytes=0-1,5-9'); // multi-range: reactor answers 200
    });
    test('missing, other units, header injection and oversized values are dropped', () => {
        assert.equal(forwardableRange(null), null);
        assert.equal(forwardableRange(''), null);
        assert.equal(forwardableRange('items=0-1'), null);
        assert.equal(forwardableRange('bytes=0-1\r\nX-Evil: 1'), null);
        assert.equal(forwardableRange('bytes=' + '1'.repeat(300) + '-'), null);
    });
});

describe('reactor response mapping', () => {
    test('206 passes range headers through, app content headers win', () => {
        const m = mapReactorResponse(206, hdrs({
            'content-range': 'bytes 10-19/100', 'content-length': '10', 'accept-ranges': 'bytes',
            etag: `"${ID}"`, 'content-type': 'application/octet-stream', 'set-cookie': 'x=1',
        }), APP);
        assert.equal(m.kind, 'pass');
        if (m.kind !== 'pass') return;
        assert.equal(m.status, 206);
        assert.equal(m.headers['Content-Range'], 'bytes 10-19/100');
        assert.equal(m.headers['Content-Length'], '10');
        assert.equal(m.headers['ETag'], `"${ID}"`);
        assert.equal(m.headers['Content-Type'], 'video/mp4');
        assert.equal(m.headers['X-Content-Type-Options'], 'nosniff');
        assert.equal(m.headers['Accept-Ranges'], 'bytes');
        assert.ok(!Object.keys(m.headers).some((k) => k.toLowerCase() === 'set-cookie'));
    });
    test('200 full body keeps Content-Length; disposition/cache rules from the app survive', () => {
        const m = mapReactorResponse(200, hdrs({ 'content-length': '100', 'accept-ranges': 'bytes' }), {
            ...APP, 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment', 'Cache-Control': 'private, no-store',
        });
        assert.ok(m.kind === 'pass' && m.status === 200);
        if (m.kind !== 'pass') return;
        assert.equal(m.headers['Content-Length'], '100');
        assert.equal(m.headers['Content-Disposition'], 'attachment');
        assert.equal(m.headers['Cache-Control'], 'private, no-store');
        assert.equal(m.headers['Content-Range'], undefined);
    });
    test('416 passes Content-Range */size and a zero length', () => {
        const m = mapReactorResponse(416, hdrs({ 'content-range': 'bytes */100' }), APP);
        assert.ok(m.kind === 'pass' && m.status === 416);
        if (m.kind !== 'pass') return;
        assert.equal(m.headers['Content-Range'], 'bytes */100');
        assert.equal(m.headers['Content-Length'], '0');
    });
    test('404 -> missing; other statuses -> error', () => {
        assert.deepEqual(mapReactorResponse(404, hdrs({}), APP), { kind: 'missing' });
        assert.deepEqual(mapReactorResponse(401, hdrs({}), APP), { kind: 'error', upstreamStatus: 401 });
        assert.deepEqual(mapReactorResponse(503, hdrs({}), APP), { kind: 'error', upstreamStatus: 503 });
        assert.deepEqual(mapReactorResponse(500, hdrs({}), APP), { kind: 'error', upstreamStatus: 500 });
    });
    test('header values containing CR/LF are dropped', () => {
        const m = mapReactorResponse(200, hdrs({ etag: '"x"\r\nSet-Cookie: a=b' }), APP);
        assert.ok(m.kind === 'pass' && m.headers['ETag'] === undefined);
    });
});

describe('access counting (same rule as legacy paths)', () => {
    test('full responses and ranges from byte 0 count', () => {
        assert.ok(isCountedAccess(200, null));
        assert.ok(isCountedAccess(206, 'bytes 0-0/100'));
        assert.ok(isCountedAccess(206, 'bytes 0-99/100'));
    });
    test('continuations, 416 and errors do not count', () => {
        assert.ok(!isCountedAccess(206, 'bytes 10-99/100'));
        assert.ok(!isCountedAccess(206, null));
        assert.ok(!isCountedAccess(416, 'bytes */100'));
        assert.ok(!isCountedAccess(404, null));
    });
});

describe('PUT /store/files result', () => {
    const ok = { file_id: ID.toUpperCase(), size: 1000, stored_bytes: 400, new_chunks: 1, dedup_chunks: 0, chunks: 1, class: 'text/json', duplicate: false, pins: 1 };
    test('valid body is normalised', () => {
        const r = parseStorePutResult(ok);
        assert.equal(r.file_id, ID);
        assert.equal(r.size, 1000);
        assert.equal(r.class, 'text/json');
        assert.equal(r.pins, 1);
    });
    test('invalid ids/sizes are rejected; odd optional fields are tolerated', () => {
        assert.throws(() => parseStorePutResult(null));
        assert.throws(() => parseStorePutResult({ ...ok, file_id: 'abc' }));
        assert.throws(() => parseStorePutResult({ ...ok, size: -1 }));
        const r = parseStorePutResult({ file_id: ID, size: 5, class: 'bad class!' });
        assert.equal(r.class, null);
        assert.equal(r.stored_bytes, 0);
        assert.equal(r.duplicate, false);
    });
    test('ratio formatting never yields the legacy 1.0x marker', () => {
        const put = (o: Partial<Parameters<typeof formatStoreRatio>[0]>) =>
            ({ size: 1000, stored_bytes: 400, duplicate: false, new_chunks: 4, dedup_chunks: 0, chunks: 4, ...o });
        assert.equal(formatStoreRatio(put({})), '2.50x compressed');
        assert.equal(formatStoreRatio(put({ stored_bytes: 0, duplicate: true, new_chunks: 0, dedup_chunks: 4 })), '100% dedup');
        assert.equal(formatStoreRatio(put({ stored_bytes: 1000 })), '1.00x compressed');
        assert.equal(formatStoreRatio(put({ size: 0, stored_bytes: 0, new_chunks: 0, chunks: 0 })), 'empty');
    });
    test('507 message is human readable', () => {
        assert.match(storeFullMessage({ error: 'store full', needed: 1, used: 1048576, max: 2097152 }), /Storage is full.*1\.0 MiB of 2\.0 MiB/);
        assert.match(storeFullMessage(null), /^Storage is full/);
    });
});
