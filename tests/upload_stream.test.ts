/**
 * Unit tests for streaming uploads (diocom-app/src/lib/upload/multipartStream.ts) and the honest store ratio figures
 * (diocom-app/src/lib/storage/reactorStoreCore.ts computeStoreRatios / formatStoreRatio).
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import {
    parseMultipartUpload, UploadSink, UploadTooLargeError, MultipartError, sniffFileType, isThumbnailableImage, mayStreamSample,
} from '../diocom-app/src/lib/upload/multipartStream';
import { computeStoreRatios, formatStoreRatio } from '../diocom-app/src/lib/storage/reactorStoreCore';

const BOUNDARY = '----diocomTestBoundary7MA4YWxkTrZu0gW';
const HEADERS = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

type Part = { name: string; value: string } | { name: string; filename: string; type: string; data: Buffer };

function multipart(parts: Part[]): Buffer {
    const out: Buffer[] = [];
    for (const p of parts) {
        out.push(Buffer.from(`--${BOUNDARY}\r\n`));
        if ('data' in p) {
            out.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.type}\r\n\r\n`));
            out.push(p.data);
        } else {
            out.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}`));
        }
        out.push(Buffer.from('\r\n'));
    }
    out.push(Buffer.from(`--${BOUNDARY}--\r\n`));
    return Buffer.concat(out);
}

/** Feeds the body in small, irregular pieces (boundaries split across chunks). */
function source(body: Buffer, piece = 777): Readable {
    let off = 0;
    return new Readable({
        read() {
            if (off >= body.length) { this.push(null); return; }
            const n = Math.min(piece + (off % 13), body.length - off);
            this.push(body.subarray(off, off + n));
            off += n;
        },
    });
}

function memorySink() {
    const got: Buffer[] = [];
    const state = { opened: 0, ended: false, aborted: null as Error | null, before: null as Record<string, string> | null };
    const open = (_info: unknown, before: Readonly<Record<string, string>>): UploadSink<Buffer> => {
        state.opened++;
        state.before = { ...before };
        return {
            async write(c) { got.push(Buffer.from(c)); },
            async end() { state.ended = true; return Buffer.concat(got); },
            abort(r) { state.aborted = r; },
        };
    };
    return { open, state };
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const rand = (n: number, seed = 1) => {
    const b = Buffer.alloc(n);
    let x = seed;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
    return b;
};
const base = { maxFileBytes: 1 << 20, deferBytes: 4096, imageBufferCap: 8192 };

describe('streaming multipart parser', () => {
    test('small file stays in memory, no sink opened; fields before and after the file are all returned', async () => {
        const data = rand(1000);
        const { open, state } = memorySink();
        const r = await parseMultipartUpload(source(multipart([
            { name: 'iv', value: 'abc' },
            { name: 'file', filename: 'a.bin', type: 'application/octet-stream', data },
            { name: 'is_encrypted', value: 'true' },
            { name: 'tags', value: '["x"]' },
        ])), HEADERS, { ...base, openSink: open });
        assert.equal(state.opened, 0);
        assert.ok(r.file);
        assert.equal(r.file.size, 1000);
        assert.equal(r.file.sha256, sha(data));
        assert.deepEqual(r.file.buffered, data);
        assert.equal(r.file.sinkResult, null);
        assert.equal(r.file.filename, 'a.bin');
        assert.deepEqual(r.fields, { iv: 'abc', is_encrypted: 'true', tags: '["x"]' });
        assert.deepEqual(r.file.fieldsBeforeFile, { iv: 'abc' });
    });

    test('large file streams through the sink byte-exact, with incremental hash and head', async () => {
        const data = rand(300_000, 7);
        const { open, state } = memorySink();
        const r = await parseMultipartUpload(source(multipart([
            { name: 'file', filename: 'big.bin', type: 'application/octet-stream', data },
            { name: 'password', value: 'pw' },
        ]), 65536), HEADERS, { ...base, openSink: open });
        assert.equal(state.opened, 1);
        assert.equal(state.ended, true);
        assert.ok(r.file);
        assert.equal(r.file.buffered, null);
        assert.deepEqual(r.file.sinkResult, data);
        assert.equal(r.file.sha256, sha(data));
        assert.deepEqual(r.file.head, data.subarray(0, 4096));
        assert.equal(r.fields.password, 'pw');
        assert.deepEqual(state.before, {}); // password arrived after the file: unknown when the sink opened
    });

    test('exceeding maxFileBytes aborts the sink and rejects with UploadTooLargeError', async () => {
        const data = rand(50_000);
        const { open, state } = memorySink();
        await assert.rejects(parseMultipartUpload(source(multipart([
            { name: 'file', filename: 'x', type: 'application/octet-stream', data },
        ])), HEADERS, { ...base, maxFileBytes: 20_000, openSink: open }), UploadTooLargeError);
        assert.equal(state.opened, 1);
        assert.ok(state.aborted instanceof UploadTooLargeError);
        assert.equal(state.ended, false);
    });

    test('a file exactly at the limit is accepted', async () => {
        const data = rand(20_000);
        const { open } = memorySink();
        const r = await parseMultipartUpload(source(multipart([
            { name: 'file', filename: 'x', type: 'application/octet-stream', data },
        ])), HEADERS, { ...base, maxFileBytes: 20_000, openSink: open });
        assert.equal(r.file?.size, 20_000);
    });

    test('sink failure (e.g. store full) propagates and nothing is resolved', async () => {
        const data = rand(50_000);
        const boom = new Error('store full');
        await assert.rejects(parseMultipartUpload(source(multipart([
            { name: 'file', filename: 'x', type: 'application/octet-stream', data },
        ])), HEADERS, {
            ...base,
            openSink: () => ({ write: async () => { throw boom; }, end: async () => Buffer.alloc(0), abort: () => { } }),
        }), (e) => e === boom);
    });

    test('onFileStart rejection stops before any sink is opened', async () => {
        const { open, state } = memorySink();
        await assert.rejects(parseMultipartUpload(source(multipart([
            { name: 'file', filename: 'x.exe', type: 'application/x-msdownload', data: rand(50_000) },
        ])), HEADERS, { ...base, openSink: open, onFileStart: () => { throw new Error('type not allowed'); } }), /type not allowed/);
        assert.equal(state.opened, 0);
    });

    test('no file part -> file null; extra and differently named file parts are ignored', async () => {
        const { open } = memorySink();
        const none = await parseMultipartUpload(source(multipart([{ name: 'tags', value: 'a,b' }])), HEADERS, { ...base, openSink: open });
        assert.equal(none.file, null);
        assert.equal(none.fields.tags, 'a,b');

        const first = Buffer.from('first'), second = Buffer.from('second');
        const r = await parseMultipartUpload(source(multipart([
            { name: 'attachment', filename: 'o', type: 'text/plain', data: Buffer.from('other') },
            { name: 'file', filename: '1', type: 'text/plain', data: first },
            { name: 'file', filename: '2', type: 'text/plain', data: second },
        ])), HEADERS, { ...base, openSink: open });
        assert.deepEqual(r.file?.buffered, first);
        assert.equal(r.file?.filename, '1');
    });

    test('empty file is reported with size 0', async () => {
        const { open } = memorySink();
        const r = await parseMultipartUpload(source(multipart([
            { name: 'file', filename: 'e', type: 'text/plain', data: Buffer.alloc(0) },
        ])), HEADERS, { ...base, openSink: open });
        assert.equal(r.file?.size, 0);
        assert.equal(r.file?.sha256, sha(Buffer.alloc(0)));
    });

    test('image buffer is kept only under the cap', async () => {
        const { open } = memorySink();
        const small = rand(6000), big = rand(9000);
        const a = await parseMultipartUpload(source(multipart([{ name: 'file', filename: 'a.png', type: 'image/png', data: small }])), HEADERS, { ...base, openSink: open });
        assert.deepEqual(a.file?.imageBuffer, small);
        const b = await parseMultipartUpload(source(multipart([{ name: 'file', filename: 'b.png', type: 'image/png', data: big }])), HEADERS, { ...base, openSink: memorySink().open });
        assert.equal(b.file?.imageBuffer, null);
        const c = await parseMultipartUpload(source(multipart([{ name: 'file', filename: 'c.bin', type: 'application/octet-stream', data: small }])), HEADERS, { ...base, openSink: open });
        assert.equal(c.file?.imageBuffer, null);
    });

    test('oversized text field and malformed bodies are MultipartErrors', async () => {
        const { open } = memorySink();
        await assert.rejects(parseMultipartUpload(source(multipart([{ name: 'summary', value: 'x'.repeat(5000) }])), HEADERS,
            { ...base, maxFieldBytes: 1000, openSink: open }), MultipartError);
        await assert.rejects(parseMultipartUpload(source(Buffer.from('x')), { 'content-type': 'text/plain' }, { ...base, openSink: open }), MultipartError);
    });

    test('client abort mid-file rejects and aborts the sink', async () => {
        const body = multipart([{ name: 'file', filename: 'x', type: 'application/octet-stream', data: rand(100_000) }]);
        const src = new Readable({ read() { } });
        const { open, state } = memorySink();
        const p = parseMultipartUpload(src, HEADERS, { ...base, openSink: open });
        src.push(body.subarray(0, 60_000));
        setTimeout(() => src.destroy(new Error('socket hang up')), 20);
        await assert.rejects(p, /socket hang up/);
        assert.ok(state.aborted);
    });
});

describe('upload helpers', () => {
    test('magic-byte sniffing', () => {
        assert.equal(sniffFileType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
        assert.equal(sniffFileType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image/png');
        assert.equal(sniffFileType(Buffer.from('GIF89a....')), 'image/gif');
        assert.equal(sniffFileType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
        assert.equal(sniffFileType(Buffer.from('%PDF-1.7')), 'application/pdf');
        assert.equal(sniffFileType(Buffer.from('\0\0\0\x20ftypisom')), 'video/mp4');
        assert.equal(sniffFileType(Buffer.from('hello world')), null);
        assert.equal(sniffFileType(Buffer.alloc(0)), null);
        assert.equal(isThumbnailableImage('image/png'), true);
        assert.equal(isThumbnailableImage('application/pdf'), false);
        assert.equal(isThumbnailableImage(null), false);
    });

    test('streamed uploads are sampled only when both flags were declared up front as unprotected', () => {
        assert.equal(mayStreamSample({}), false);
        assert.equal(mayStreamSample({ is_encrypted: 'false' }), false);
        assert.equal(mayStreamSample({ is_encrypted: 'false', password: '' }), true);
        assert.equal(mayStreamSample({ is_encrypted: 'true', password: '' }), false);
        assert.equal(mayStreamSample({ is_encrypted: 'false', password: 'pw' }), false);
    });
});

describe('store ratio figures (compression vs dedup)', () => {
    const put = (o: Partial<Parameters<typeof computeStoreRatios>[0]>) =>
        ({ size: 1_000_000, stored_bytes: 400_000, duplicate: false, new_chunks: 10, dedup_chunks: 0, chunks: 10, ...o });

    test('no dedup: exact compression, 0% dedup', () => {
        const r = computeStoreRatios(put({}));
        assert.equal(r.compression, 2.5);
        assert.equal(r.compressionEstimated, false);
        assert.equal(r.dedupPercent, 0);
        assert.equal(formatStoreRatio(put({})), '2.50x compressed');
    });

    test('mostly deduplicated upload no longer inflates the ratio (was size/stored = 167x)', () => {
        // 1 MB file, 9 of 10 chunks already stored, the new chunk compressed to 60 KB.
        const p = put({ stored_bytes: 6_000, new_chunks: 1, dedup_chunks: 9 });
        const r = computeStoreRatios(p);
        assert.ok(Math.abs((r.compression ?? 0) - 100_000 / 6_000) < 1e-9); // new-chunk bytes estimated as size*1/10
        assert.equal(r.compressionEstimated, true);
        assert.equal(r.dedupPercent, 90);
        assert.equal(formatStoreRatio(p), '~16.67x compressed · 90% dedup');
    });

    test('incompressible new data with partial dedup', () => {
        const p = put({ stored_bytes: 500_100, new_chunks: 5, dedup_chunks: 5 });
        assert.equal(formatStoreRatio(p), '~1.00x compressed · 50% dedup');
    });

    test('full duplicate / all chunks known: no compression figure, 100% dedup', () => {
        const dup = put({ stored_bytes: 0, duplicate: true, new_chunks: 0, dedup_chunks: 10 });
        assert.deepEqual(computeStoreRatios(dup), { compression: null, compressionEstimated: false, dedupPercent: 100 });
        assert.equal(formatStoreRatio(dup), '100% dedup');
        assert.equal(formatStoreRatio(put({ stored_bytes: 0, new_chunks: 0, dedup_chunks: 10 })), '100% dedup');
    });

    test('chunks missing from the response falls back to new+dedup; tiny/huge dedup shares are not rounded to 0/100', () => {
        assert.equal(computeStoreRatios(put({ chunks: null, new_chunks: 3, dedup_chunks: 1 })).dedupPercent, 25);
        assert.equal(formatStoreRatio(put({ chunks: 1000, new_chunks: 999, dedup_chunks: 1, stored_bytes: 500_000 })), '~2.00x compressed · <1% dedup');
        assert.equal(formatStoreRatio(put({ chunks: 1000, new_chunks: 1, dedup_chunks: 999, stored_bytes: 500 })), '~2.00x compressed · >99% dedup');
    });

    test('reactor-reported new_bytes makes compression exact under partial dedup', () => {
        // 9 of 10 chunks known; the new chunk was 130 KB of plaintext stored in 6.5 KB (not the size/10 estimate).
        const p = put({ stored_bytes: 6_500, new_chunks: 1, dedup_chunks: 9, new_bytes: 130_000 });
        const r = computeStoreRatios(p);
        assert.equal(r.compression, 20);
        assert.equal(r.compressionEstimated, false);
        assert.equal(formatStoreRatio(p), '20.00x compressed · 90% dedup');
        // new_bytes 0 / null (older reactor) falls back to the estimate
        assert.equal(computeStoreRatios(put({ stored_bytes: 6_000, new_chunks: 1, dedup_chunks: 9, new_bytes: null })).compressionEstimated, true);
    });

    test('empty file', () => {
        assert.deepEqual(computeStoreRatios(put({ size: 0, stored_bytes: 0, new_chunks: 0, chunks: 0 })), { compression: null, compressionEstimated: false, dedupPercent: null });
        assert.equal(formatStoreRatio(put({ size: 0, stored_bytes: 0, new_chunks: 0, chunks: 0 })), 'empty');
    });
});
