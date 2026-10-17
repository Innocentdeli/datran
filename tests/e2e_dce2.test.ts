/**
 * DCE2 chunked streaming end-to-end encryption (diocom-app/src/lib/crypto/dce2.ts) and its Service Worker decrypt
 * mirror (diocom-app/public/e2e-core.js): round trips, random access, integrity (tamper / reorder / truncate /
 * extend / last-chunk flag), header AAD binding, cross-implementation parity, and v1 single-shot compatibility.
 */
import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import {
    importMasterKey, encryptBytes, decryptBytes, decryptRangeStream, decryptFullStream, collect, parseHeader, createHeader,
    deriveFileKey, decryptChunk, encryptChunk, chunkCount, plainChunkLength, cipherChunkOffset, ciphertextLength,
    encryptedSize, plaintextRangeToCipherRange, chunkNonce, encryptSourceChunks, hasDce2Magic,
    Dce2IntegrityError, Dce2FormatError, Dce2Header, DCE2_HEADER_LENGTH, DCE2_TAG_LENGTH, DCE2_DEFAULT_CHUNK_SIZE, DCE2_DB_MARKER,
} from '../diocom-app/src/lib/crypto/dce2';
import * as Encryption from '../diocom-app/src/lib/crypto/Encryption';
import { encryptionFormatOf } from '../diocom-app/src/lib/crypto/e2eClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require(path.join(__dirname, '..', 'diocom-app', 'public', 'e2e-core.js'));

const C = 256; // small chunk size keeps the boundary tests fast
const KEY = new Uint8Array(32).map((_, i) => i * 7 + 1);

function randomBytes(n: number): Uint8Array {
    const out = new Uint8Array(n);
    for (let off = 0; off < n; off += 65536) globalThis.crypto.getRandomValues(out.subarray(off, Math.min(n, off + 65536)));
    return out;
}

/** Ciphertext slice as a stream delivered in odd-sized pieces (exercises partial reads). */
function streamOf(bytes: Uint8Array, piece = 97): ReadableStream<Uint8Array> {
    let off = 0;
    return new ReadableStream<Uint8Array>({
        pull(c) {
            if (off >= bytes.length) return c.close();
            c.enqueue(bytes.slice(off, off + piece));
            off += piece;
        },
    });
}

function opener(ct: Uint8Array) {
    return async (s: number, e: number) => streamOf(ct.subarray(s, e + 1));
}

async function rangeTs(ct: Uint8Array, master: CryptoKey, start: number, end: number) {
    const header = parseHeader(ct);
    const fileKey = await deriveFileKey(master, header);
    return collect(decryptRangeStream({ fileKey, header, start, end, openCiphertext: opener(ct) }));
}

async function rangeCore(ct: Uint8Array, start: number, end: number) {
    const header = core.parseHeader(ct);
    const master = await core.importMasterKey(KEY);
    const fileKey = await core.deriveFileKey(master, header);
    return collect(core.decryptRangeStream({ fileKey, header, start, end, openCiphertext: opener(ct) }));
}

async function rejectsIntegrity(p: Promise<unknown>) {
    await assert.rejects(p, (err: Error) => err.name === 'Dce2IntegrityError' || err instanceof Dce2IntegrityError);
}

describe('DCE2 layout', () => {
    test('chunk count, sizes, offsets and total length', () => {
        const h = { chunkSize: C, plaintextLength: 0 };
        assert.equal(chunkCount(h), 1);
        assert.equal(plainChunkLength(h, 0), 0);
        assert.equal(ciphertextLength(h), DCE2_HEADER_LENGTH + DCE2_TAG_LENGTH);
        const g = { chunkSize: C, plaintextLength: 3 * C + 5 };
        assert.equal(chunkCount(g), 4);
        assert.equal(plainChunkLength(g, 3), 5);
        assert.equal(cipherChunkOffset(g, 2), DCE2_HEADER_LENGTH + 2 * (C + 16));
        assert.equal(ciphertextLength(g), DCE2_HEADER_LENGTH + 4 * 16 + 3 * C + 5);
        assert.equal(chunkCount({ chunkSize: C, plaintextLength: 2 * C }), 2);
    });

    test('plaintext range maps to the covering ciphertext range', () => {
        const g = { chunkSize: C, plaintextLength: 3 * C + 5 };
        assert.deepEqual(plaintextRangeToCipherRange(g, 0, 1), { firstChunk: 0, lastChunk: 0, cipherStart: 44, cipherEnd: 44 + C + 16 - 1 });
        const r = plaintextRangeToCipherRange(g, C - 1, C + 1);
        assert.equal(r.firstChunk, 0);
        assert.equal(r.lastChunk, 1);
        const last = plaintextRangeToCipherRange(g, 3 * C, 3 * C + 5);
        assert.equal(last.cipherEnd, ciphertextLength(g) - 1);
        assert.throws(() => plaintextRangeToCipherRange(g, 5, 5), Dce2FormatError);
        assert.throws(() => plaintextRangeToCipherRange(g, 0, 3 * C + 6), Dce2FormatError);
        assert.deepEqual(core.plaintextRangeToCipherRange(g, C - 1, C + 1), r);
    });

    test('header encode/parse and validation', () => {
        const h = createHeader({ plaintextLength: 123456789012, chunkSize: DCE2_DEFAULT_CHUNK_SIZE });
        assert.equal(h.bytes.length, DCE2_HEADER_LENGTH);
        assert.ok(hasDce2Magic(h.bytes));
        const p = parseHeader(h.bytes);
        assert.equal(p.plaintextLength, 123456789012);
        assert.equal(p.chunkSize, DCE2_DEFAULT_CHUNK_SIZE);
        const c = core.parseHeader(h.bytes);
        assert.equal(c.plaintextLength, 123456789012);
        assert.deepEqual(Array.from(c.salt), Array.from(p.salt));
        assert.deepEqual(Array.from(c.noncePrefix), Array.from(p.noncePrefix));
        const bad = (mut: (b: Uint8Array) => void) => {
            const b = new Uint8Array(h.bytes);
            mut(b);
            assert.throws(() => parseHeader(b), Dce2FormatError);
            assert.throws(() => core.parseHeader(b), (e: Error) => e.name === 'Dce2FormatError');
        };
        bad((b) => { b[0] = 0x58; });           // magic
        bad((b) => { b[4] = 3; });              // version
        bad((b) => { b[5] = 9; });              // algorithm
        bad((b) => { b[7] = 1; });              // reserved
        bad((b) => { b[43] = 1; });             // reserved
        bad((b) => { new DataView(b.buffer).setUint32(8, 16); });       // chunk too small
        bad((b) => { new DataView(b.buffer).setUint32(12, 0x00400000); }); // length > 2^53
        assert.throws(() => parseHeader(h.bytes.subarray(0, 43)), Dce2FormatError);
    });

    test('nonce = prefix || counter || last flag', () => {
        const h = createHeader({ plaintextLength: 2 * C + 1, chunkSize: C, noncePrefix: new Uint8Array([1, 2, 3, 4, 5, 6, 7]) });
        assert.deepEqual(Array.from(chunkNonce(h, 1)), [1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 1, 0]);
        assert.deepEqual(Array.from(chunkNonce(h, 2)), [1, 2, 3, 4, 5, 6, 7, 0, 0, 0, 2, 1]);
    });
});

describe('DCE2 round trip', () => {
    for (const size of [0, 1, C - 1, C, C + 1, 5 * C + 3, 8 * C]) {
        test(`size ${size}`, async () => {
            const master = await importMasterKey(KEY);
            const pt = randomBytes(size);
            const ct = await encryptBytes(master, pt, { chunkSize: C });
            assert.equal(ct.length, encryptedSize(size, C));
            assert.deepEqual(await decryptBytes(master, ct), pt);
            // Full stream through the SW mirror (range covering everything).
            if (size > 0) assert.deepEqual(await rangeCore(ct, 0, size), pt);
            else assert.equal((await rangeCore(ct, 0, 0)).length, 0);
        });
    }

    test('default 1 MiB chunks, multi-chunk, from a Blob via slice()', async () => {
        const master = await importMasterKey(KEY);
        const pt = randomBytes(3 * DCE2_DEFAULT_CHUNK_SIZE + 12345);
        const parts: Uint8Array[] = [];
        let progress = 0;
        for await (const p of encryptSourceChunks(master, new Blob([pt as Uint8Array<ArrayBuffer>]), { onProgress: (d) => { progress = d; } })) parts.push(p);
        assert.equal(parts.length, 1 + 4);
        assert.equal(progress, pt.length);
        const ct = new Uint8Array(await new Blob(parts as Uint8Array<ArrayBuffer>[]).arrayBuffer());
        assert.equal(ct.length, encryptedSize(pt.length));
        const out = await collect(decryptFullStream(master, streamOf(ct, 65521), { ciphertextLength: ct.length }));
        assert.deepEqual(out, pt);
    });

    test('per-file keys differ (random salt) and wrong key fails', async () => {
        const master = await importMasterKey(KEY);
        const pt = randomBytes(1000);
        const a = await encryptBytes(master, pt, { chunkSize: C });
        const b = await encryptBytes(master, pt, { chunkSize: C });
        assert.notDeepEqual(a.subarray(44), b.subarray(44));
        const other = await importMasterKey(new Uint8Array(32).fill(9));
        await rejectsIntegrity(decryptBytes(other, a));
    });

    test('base64url link key import matches raw bytes', async () => {
        const pt = randomBytes(700);
        const ct = await encryptBytes(await importMasterKey(KEY), pt, { chunkSize: C });
        assert.deepEqual(await decryptBytes(await importMasterKey(Encryption.bytesToBase64Url(KEY)), ct), pt);
    });
});

describe('DCE2 random access', () => {
    test('every range decrypts to the plaintext slice (TS and SW mirror)', async () => {
        const master = await importMasterKey(KEY);
        const L = 6 * C + 77;
        const pt = randomBytes(L);
        const ct = await encryptBytes(master, pt, { chunkSize: C });
        const ranges: Array<[number, number]> = [
            [0, 1], [0, L], [L - 1, L], [C - 1, C], [C, C + 1], [C - 1, C + 1], [C, 2 * C], [2 * C + 5, 5 * C + 9], [6 * C, L], [3, 4],
        ];
        for (let i = 0; i < 40; i++) {
            const s = Math.floor(Math.random() * L);
            const e = s + 1 + Math.floor(Math.random() * (L - s));
            ranges.push([s, e]);
        }
        for (const [s, e] of ranges) {
            assert.deepEqual(await rangeTs(ct, master, s, e), pt.slice(s, e), `ts [${s},${e})`);
            assert.deepEqual(await rangeCore(ct, s, e), pt.slice(s, e), `core [${s},${e})`);
        }
    });

    test('range stream only fetches the covering ciphertext bytes', async () => {
        const master = await importMasterKey(KEY);
        const pt = randomBytes(10 * C);
        const ct = await encryptBytes(master, pt, { chunkSize: C });
        const header = parseHeader(ct);
        const fileKey = await deriveFileKey(master, header);
        const calls: Array<[number, number]> = [];
        const out = await collect(decryptRangeStream({
            fileKey, header, start: 4 * C + 10, end: 5 * C + 20,
            openCiphertext: async (s, e) => { calls.push([s, e]); return streamOf(ct.subarray(s, e + 1)); },
        }));
        assert.deepEqual(out, pt.slice(4 * C + 10, 5 * C + 20));
        assert.deepEqual(calls, [[cipherChunkOffset(header, 4), cipherChunkOffset(header, 6) - 1]]);
    });
});

describe('DCE2 integrity', () => {
    async function fixture(size = 4 * C + 10) {
        const master = await importMasterKey(KEY);
        const pt = randomBytes(size);
        const ct = await encryptBytes(master, pt, { chunkSize: C });
        return { master, pt, ct, header: parseHeader(ct) };
    }

    test('flipped ciphertext / tag byte in any chunk is rejected', async () => {
        const { master, ct, header } = await fixture();
        for (const i of [0, 2, chunkCount(header) - 1]) {
            for (const off of [0, 17, plainChunkLength(header, i) + 15]) {
                const bad = new Uint8Array(ct);
                bad[cipherChunkOffset(header, i) + off] ^= 0x01;
                await rejectsIntegrity(decryptBytes(master, bad));
                // Random access into just the tampered chunk fails too (both implementations).
                await rejectsIntegrity(rangeTs(bad, master, i * C, i * C + 1));
                await rejectsIntegrity(rangeCore(bad, i * C, i * C + 1));
            }
        }
    });

    test('a range stream never emits bytes of a chunk that fails authentication', async () => {
        const { master, ct, header } = await fixture();
        const bad = new Uint8Array(ct);
        bad[cipherChunkOffset(header, 2) + 3] ^= 0x80;
        const fileKey = await deriveFileKey(master, header);
        const reader = decryptRangeStream({ fileKey, header, start: 0, end: header.plaintextLength, openCiphertext: opener(bad) }).getReader();
        let got = 0;
        await rejectsIntegrity((async () => { for (; ;) { const r = await reader.read(); if (r.done) break; got += r.value.length; } })());
        assert.equal(got, 2 * C); // chunks 0 and 1 only, nothing from chunk 2
    });

    test('reordered chunks are rejected', async () => {
        const { master, ct, header } = await fixture();
        const bad = new Uint8Array(ct);
        const a = cipherChunkOffset(header, 0);
        const b = cipherChunkOffset(header, 1);
        const n = C + 16;
        bad.set(ct.subarray(b, b + n), a);
        bad.set(ct.subarray(a, a + n), b);
        await rejectsIntegrity(decryptBytes(master, bad));
        await rejectsIntegrity(rangeCore(bad, 0, 10));
    });

    test('truncation (mid-chunk, at a chunk boundary, header only) is rejected', async () => {
        const { master, ct, header } = await fixture();
        const lastStart = cipherChunkOffset(header, chunkCount(header) - 1);
        for (const cut of [ct.length - 1, lastStart, lastStart + 5, cipherChunkOffset(header, 1), DCE2_HEADER_LENGTH]) {
            await rejectsIntegrity(decryptBytes(master, ct.subarray(0, cut)));
            // Without the length hint the stream itself still detects it.
            await rejectsIntegrity(collect(decryptFullStream(master, streamOf(ct.subarray(0, cut)))));
        }
        // Range read whose server response is short.
        const fileKey = await deriveFileKey(master, header);
        await rejectsIntegrity(collect(decryptRangeStream({
            fileKey, header, start: 0, end: header.plaintextLength,
            openCiphertext: async (s, e) => streamOf(ct.subarray(s, e)), // one byte short
        })));
    });

    test('truncation to a boundary with a forged shorter length fails the header AAD', async () => {
        const { master, ct, header } = await fixture(4 * C); // exactly 4 full chunks
        // Keep 3 chunks and rewrite the header to claim 3*C bytes: chunk 2 was not encrypted as final and the
        // header (AAD) changed, so it must fail.
        const forged = new Uint8Array(cipherChunkOffset(header, 3));
        forged.set(ct.subarray(0, forged.length));
        new DataView(forged.buffer).setBigUint64(12, BigInt(3 * C));
        await rejectsIntegrity(decryptBytes(master, forged));
    });

    test('extension (trailing bytes, duplicated final chunk) is rejected', async () => {
        const { master, ct, header } = await fixture();
        const plus = new Uint8Array(ct.length + 1);
        plus.set(ct);
        await rejectsIntegrity(decryptBytes(master, plus));
        await rejectsIntegrity(collect(decryptFullStream(master, streamOf(plus))));
        const lastStart = cipherChunkOffset(header, chunkCount(header) - 1);
        const dup = new Uint8Array(ct.length + (ct.length - lastStart));
        dup.set(ct);
        dup.set(ct.subarray(lastStart), ct.length);
        await rejectsIntegrity(collect(decryptFullStream(master, streamOf(dup))));
        // Range response carrying extra bytes beyond the requested range.
        const fileKey = await deriveFileKey(master, header);
        await rejectsIntegrity(collect(decryptRangeStream({
            fileKey, header, start: 0, end: 10, openCiphertext: async (s, e) => streamOf(ct.subarray(s, e + 2)),
        })));
    });

    test('last-chunk flag is authenticated (flag flip fails both ways)', async () => {
        const { master, pt, header } = await fixture(3 * C);
        const fileKey = await deriveFileKey(master, header);
        const n = chunkCount(header);
        const encryptWithFlag = async (i: number, flag: number) => {
            const nonce = chunkNonce(header, i);
            nonce[11] = flag;
            return new Uint8Array(await globalThis.crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: nonce, additionalData: header.bytes }, fileKey, pt.slice(i * C, (i + 1) * C)));
        };
        // Final chunk sealed as non-final (what a truncating attacker would need) -> rejected.
        await rejectsIntegrity(decryptChunk(fileKey, header, n - 1, await encryptWithFlag(n - 1, 0)));
        // Non-final chunk sealed as final -> rejected.
        await rejectsIntegrity(decryptChunk(fileKey, header, 0, await encryptWithFlag(0, 1)));
        // Correctly flagged chunks decrypt.
        assert.deepEqual(await decryptChunk(fileKey, header, n - 1, await encryptWithFlag(n - 1, 1)), pt.slice((n - 1) * C));
    });

    test('header fields are bound as AAD (salt, nonce prefix, length, chunk size)', async () => {
        const { master, ct, header } = await fixture(4 * C + 10);
        const fileKey = await deriveFileKey(master, header);
        const chunk0 = ct.subarray(cipherChunkOffset(header, 0), cipherChunkOffset(header, 1));
        // Same derived key and same chunk-0 nonce, only the AAD differs: length changed within the same chunk count.
        const lengthChanged: Dce2Header = parseHeader((() => {
            const b = new Uint8Array(header.bytes);
            new DataView(b.buffer).setBigUint64(12, BigInt(4 * C + 9));
            return b;
        })());
        await rejectsIntegrity(decryptChunk(fileKey, lengthChanged, 0, chunk0));
        // Salt change -> different file key; nonce prefix change -> different nonce; both rejected end to end.
        for (const off of [20, 35, 36, 42]) {
            const bad = new Uint8Array(ct);
            bad[off] ^= 0x01;
            await rejectsIntegrity(decryptBytes(master, bad));
            await rejectsIntegrity(rangeCore(bad, 0, 1));
        }
        // Chunk size change (layout shifts) is rejected.
        const bad = new Uint8Array(ct);
        new DataView(bad.buffer).setUint32(8, 2 * C);
        await rejectsIntegrity(decryptBytes(master, bad));
        // Sanity: encryptChunk refuses a wrong-size chunk.
        await assert.rejects(encryptChunk(fileKey, header, 0, new Uint8Array(C - 1)), Dce2FormatError);
    });
});

describe('v1 compatibility', () => {
    test('legacy single-shot AES-GCM (IV in DB) still decrypts', async () => {
        const key = await Encryption.generateKey();
        const keyStr = await Encryption.exportKey(key);
        const pt = randomBytes(5000);
        const { encryptedData, iv } = await Encryption.encryptFile(new File([pt as Uint8Array<ArrayBuffer>], 'a.bin'), key);
        const ivStr = Encryption.bytesToBase64Url(iv);
        assert.equal(ivStr.length, 16); // can never equal the 4-char DCE2 marker
        const imported = await Encryption.importKey(keyStr);
        const out = new Uint8Array(await Encryption.decryptBuffer(encryptedData, imported, Encryption.base64UrlToBytes(ivStr)));
        assert.deepEqual(out, pt);
        // The same link key also works as DCE2 HKDF input.
        const ct = await encryptBytes(await importMasterKey(keyStr), pt, { chunkSize: C });
        assert.deepEqual(await decryptBytes(await importMasterKey(keyStr), ct), pt);
    });

    test('format detection from file metadata', () => {
        assert.equal(encryptionFormatOf({ is_encrypted: 0, encryption_iv: null }), null);
        assert.equal(encryptionFormatOf({ is_encrypted: 1, encryption_iv: 'AAAAAAAAAAAAAAAA' }), 'v1');
        assert.equal(encryptionFormatOf({ is_encrypted: 1, encryption_iv: DCE2_DB_MARKER }), 'dce2');
        assert.equal(encryptionFormatOf({ is_encrypted: 1, encryption_iv: null }), null);
        assert.equal(encryptionFormatOf({ is_encrypted: 1, encryption_iv: 'x', encryption_format: 'dce2' }), 'dce2');
    });
});
