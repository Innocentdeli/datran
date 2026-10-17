import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import {
    DiocomReactor, V2Filter, V2_HEADER_SIZE, crc32, invertFilter,
    proceduralDecode, proceduralEncode, writeVarint,
    PROC_OP_LITERAL as LIT, PROC_OP_FILL as FILL, PROC_OP_REPEAT as REP, PROC_OP_ARITH as ARITH,
} from '../src/core/DiocomReactor';

DiocomReactor.verbose = false;
const HAS_ZSTD = typeof (zlib as any).zstdCompressSync === 'function';
const V2_FIXTURES = path.join(__dirname, '..', 'core-reactor', 'tests', 'fixtures', 'v2');
const skip = !HAS_ZSTD && 'Node lacks zstd';

function prng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 8; };
}
const randomBytes = (n: number, seed: number) => { const r = prng(seed); return Buffer.from(Array.from({ length: n }, () => r() & 0xff)); };
const dec = (b: Buffer, maxOutputBytes?: number) => DiocomReactor.decompress(b, { dictionaryResolver: () => null, maxOutputBytes });

/** Reference ARITH generator (BigInt, independent of the decoder). */
function arith(w: number, be: boolean, k: number, start: bigint, delta: bigint): Buffer {
    const m = (1n << BigInt(8 * w)) - 1n;
    const out = Buffer.alloc(k * w);
    for (let i = 0; i < k; i++) {
        const v = (start + BigInt(i) * delta) & m;
        for (let t = 0; t < w; t++) out[i * w + (be ? w - 1 - t : t)] = Number((v >> BigInt(8 * t)) & 0xffn);
    }
    return out;
}
const periodic = (pattern: Buffer, len: number) => Buffer.from(Array.from({ length: len }, (_, i) => pattern[i % pattern.length]));
const WIDTHS: Array<[number, boolean]> = [[1, false], [2, false], [2, true], [4, false], [4, true], [8, false], [8, true]];
const maskOf = (w: number) => (1n << BigInt(8 * w)) - 1n;

function mixed(seed: number): Buffer {
    return Buffer.concat([
        Buffer.from('alpha beta gamma reactor datran '.repeat(60)),
        Buffer.alloc(3000),
        arith(4, false, 2000, 7n, 3n),
        periodic(randomBytes(300, seed), 6000),
        randomBytes(500, seed + 1),
        arith(8, true, 200, maskOf(8) - 5n, 0x0123456789abcdefn),
        Buffer.alloc(40, 0xee),
        arith(2, true, 1000, 0xfff0n, 0x0101n),
        periodic(Buffer.from('abc'), 999),
    ]);
}

const FILTERS: Array<[V2Filter, number]> = [['none', 0], ['delta', 1], ['delta', 4], ['delta', 8], ['shuffle', 2], ['shuffle', 4], ['shuffle', 8]];

describe('procedural codec (blob v2 codec 5)', { skip }, () => {
    test('round-trips: fills, periodic, arith (all widths/endians, wrapping), mixed, random, edge sizes x filters', () => {
        const sets: Record<string, Buffer> = {
            empty: Buffer.alloc(0), one: Buffer.from([0x42]), two: Buffer.from([1, 2]),
            fill: Buffer.alloc(50_000, 0xab), periodic3: periodic(Buffer.from('xyz'), 20_000),
            periodic1000: periodic(randomBytes(1000, 9), 30_000), mixed: mixed(1), random: randomBytes(20_000, 3),
            text: Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(300)),
        };
        for (const [w, be] of WIDTHS) {
            sets[`arith${w}${be ? 'be' : 'le'}_wrap`] = arith(w, be, 1001, maskOf(w) - 2n, maskOf(w) - BigInt(3 * w));
            sets[`arith${w}${be ? 'be' : 'le'}_up`] = arith(w, be, 700, 0n, 1n);
        }
        for (const [name, data] of Object.entries(sets)) {
            for (const [filter, stride] of FILTERS) {
                for (const level of [1, 19]) {
                    const blob = DiocomReactor.encodeV2(data, { codec: 'procedural', level, filter, stride });
                    assert.equal(blob[2], 5);
                    assert.ok(dec(blob).equals(data), `${name} ${filter}${stride} l${level}`);
                }
            }
        }
    });

    test('encoder emits programs: fill-only has no literal stream; arith and repeat are tiny', () => {
        const fill = DiocomReactor.encodeV2(Buffer.alloc(100_000, 7), { codec: 'procedural', filter: 'none', stride: 0 });
        assert.deepEqual([...fill.subarray(V2_HEADER_SIZE)], [5, FILL, 0xa0, 0x8d, 0x06, 7]);
        for (const [w, be] of WIDTHS) {
            const d = arith(w, be, 1000, maskOf(w) - 1n, maskOf(w) / 3n + 5n);
            const b = DiocomReactor.encodeV2(d, { codec: 'procedural', filter: 'none', stride: 0 });
            assert.ok(b.length <= V2_HEADER_SIZE + 1 + 3 + 2 + 2 * w, `w${w}`);
            assert.ok(dec(b).equals(d));
        }
        const counter = Buffer.alloc(4 << 20);
        for (let i = 0; i < 1 << 20; i++) counter.writeUInt32LE((i * 3 + 7) >>> 0, i * 4);
        const big = Buffer.concat([counter, Buffer.alloc(1 << 22, 0x5a), periodic(randomBytes(1000, 4), 1 << 22)]);
        const b = DiocomReactor.encodeV2(big, { codec: 'procedural', level: 19, filter: 'none', stride: 0 });
        assert.ok(big.length / b.length > 5000, `ratio ${big.length / b.length}`);
        assert.ok(dec(b).equals(big));
    });

    test('spec program: every op, wrapping and big-endian ARITH, overlapping REPEAT; ops apply to filtered bytes', () => {
        const { payload, expected } = specProgram();
        assert.ok(proceduralDecode(payload, expected.length).equals(expected));
        assert.ok(dec(blob(expected, payload)).equals(expected));
        const unfiltered = invertFilter(expected, 'delta', 1);
        assert.ok(dec(blob(unfiltered, payload, 1, 1)).equals(unfiltered));
    });

    test('Rust-generated codec 5 fixtures decode (MANIFEST)', () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(V2_FIXTURES, 'MANIFEST.json'), 'utf8'));
        const proc = manifest.fixtures.filter((e: any) => e.recipe?.codec === 'procedural');
        assert.ok(proc.length >= 5, `only ${proc.length} procedural fixtures`);
        for (const e of proc) {
            const b = fs.readFileSync(path.join(V2_FIXTURES, e.blob));
            assert.equal(b[2], 5, e.name);
            assert.ok(dec(b).equals(fs.readFileSync(path.join(V2_FIXTURES, e.original))), e.name);
        }
    });
});

// ---------------- hand-built programs ----------------

const vi = (v: number) => { const o: number[] = []; writeVarint(o, v); return o; };
const zstd = (b: Buffer) => (zlib as any).zstdCompressSync(b) as Buffer;
function payloadOf(prog: number[], lits: Buffer | string = ''): Buffer {
    const l = Buffer.from(lits);
    return Buffer.concat([Buffer.from(vi(prog.length)), Buffer.from(prog), l.length ? zstd(l) : Buffer.alloc(0)]);
}
function blob(original: Buffer, payload: Buffer, filter = 0, stride = 0): Buffer {
    const h = Buffer.alloc(V2_HEADER_SIZE);
    h[0] = 0x10; h[1] = 1; h[2] = 5; h[3] = filter; h[4] = stride;
    h.writeBigUInt64LE(BigInt(original.length), 5);
    h.writeUInt32LE(crc32(original), 13);
    return Buffer.concat([h, payload]);
}
function blobLen(n: number, payload: Buffer): Buffer {
    const b = blob(Buffer.alloc(0), payload);
    b.writeBigUInt64LE(BigInt(n), 5);
    return b;
}
function specProgram() {
    const prog = [FILL, 10, 0x61, LIT, 3, REP, 4, 8, ARITH, 2, 1, 3, 0x02, 0x01, 0x01, 0x00, ARITH, 4, 0, 2, 0xfe, 0xff, 0xff, 0xff, 3, 0, 0, 0];
    const expected = Buffer.concat([
        Buffer.from('aaaaaaaaaaxyzaxyzaxyz'),
        Buffer.from([0x01, 0x02, 0x01, 0x03, 0x01, 0x04]),
        Buffer.from([0xfe, 0xff, 0xff, 0xff, 0x01, 0x00, 0x00, 0x00]),
    ]);
    return { payload: payloadOf(prog, 'xyz'), expected };
}

describe('procedural decoder rejects every rule', { skip }, () => {
    const lit = (prog: number[], lits: string, n: number) => blobLen(n, payloadOf(prog, lits));
    const rejects = (b: Buffer, re: RegExp) => assert.throws(() => dec(b, 128 << 20), re);

    test('unknown op', () => { for (const op of [0x00, 0x05, 0x80, 0xff]) rejects(lit([FILL, 4, 1, op], '', 4), /unknown op/); });
    test('varint overflow and truncation', () => {
        rejects(lit([FILL, ...Array(9).fill(0xff), 0x02, 0x00], '', 4), /overflows/);
        rejects(lit([FILL, ...Array(10).fill(0x80), 0x00, 0x00], '', 4), /overflows/);
        rejects(lit([FILL, 0x84], '', 4), /truncated varint/);
        rejects(lit([REP, 1], '', 4), /truncated varint/);
        rejects(blobLen(4, Buffer.from([0x80])), /truncated varint/);
        rejects(blobLen(0, Buffer.alloc(0)), /truncated varint/);
    });
    test('op would exceed the original length', () => {
        rejects(lit([FILL, 5, 1], '', 4), /FILL op exceeds/);
        rejects(lit([LIT, 5], 'abcde', 4), /LITERAL op exceeds/);
        rejects(lit([FILL, 2, 1, REP, 1, 3], '', 4), /REPEAT op exceeds/);
        rejects(lit([ARITH, 2, 0, 3, 0, 0, 1, 0], '', 5), /ARITH op exceeds/);
        rejects(lit([ARITH, 2, 0, ...vi(2 ** 52), 0, 0, 1, 0], '', 4), /ARITH op exceeds/);
    });
    test('total output != original length', () => {
        rejects(lit([FILL, 3, 1], '', 4), /produces 3/);
        rejects(lit([], '', 4), /produces 0/);
    });
    test('LITERAL beyond the literal stream', () => {
        rejects(lit([LIT, 5], 'abc', 5), /beyond the literal stream/);
        rejects(lit([LIT, 5], '', 5), /beyond the literal stream/);
    });
    test('literal stream with unused trailing bytes', () => {
        rejects(lit([LIT, 3], 'abcde', 3), /unused/);
        rejects(lit([FILL, 3, 1], 'abc', 3), /unused/);
        rejects(blobLen(3, Buffer.concat([payloadOf([LIT, 3], 'abc'), Buffer.from([0])])), /trailing bytes after the literal stream/);
        rejects(blobLen(3, Buffer.concat([payloadOf([FILL, 3, 1]), Buffer.from([0x99])])), /unused/);
        // two concatenated frames (Rust decodes exactly one frame): rejected even though they hold all literals
        const two = Buffer.concat([Buffer.from(vi(2)), Buffer.from([LIT, 3]), zstd(Buffer.from('a')), zstd(Buffer.from('bc'))]);
        rejects(blobLen(3, two), /trailing bytes after the literal stream/);
    });
    test('REPEAT period invalid (0, beyond output, > 16 MiB)', () => {
        rejects(lit([FILL, 2, 1, REP, 0, 2], '', 4), /invalid REPEAT period 0/);
        rejects(lit([FILL, 2, 1, REP, 3, 2], '', 4), /invalid REPEAT period 3/);
        rejects(lit([REP, 1, 1], '', 1), /invalid REPEAT period 1/);
        const big = 16 * 1024 * 1024 + 1;
        rejects(lit([FILL, ...vi(big), 9, REP, ...vi(big), 1], '', big + 1), /invalid REPEAT period/);
        const ok = Buffer.alloc(big + 1, 9);
        assert.ok(dec(blob(ok, payloadOf([FILL, ...vi(big), 9, REP, ...vi(16 * 1024 * 1024), 1])), 128 << 20).equals(ok));
    });
    test('ARITH width/endian invalid, k*w overflow, truncated start/delta', () => {
        for (const w of [0, 3, 5, 7, 16, 255]) rejects(lit([ARITH, w, 0, 1, 0, 0], '', 1), /invalid ARITH width/);
        for (const e of [2, 255]) rejects(lit([ARITH, 1, e, 1, 0, 0], '', 1), /invalid ARITH endian/);
        // k = u64::MAX / 4 with w = 8
        rejects(lit([ARITH, 8, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x3f, ...Array(16).fill(0)], '', 8), /ARITH length overflows/);
        rejects(lit([ARITH, 4, 0, 1, 0, 0, 0, 0, 1, 0], '', 4), /truncated op/);
        rejects(lit([ARITH, 4], '', 4), /truncated op/);
        rejects(lit([FILL, 4], '', 4), /truncated/);
    });
    test('program_len beyond payload', () => {
        rejects(blobLen(4, Buffer.from([...vi(100), FILL, 4, 1])), /program length/);
    });
    test('corrupt literal frame, CRC and bombs', () => {
        const p = payloadOf([LIT, 3], 'abc');
        p[p.length - 1] ^= 0xff;
        assert.throws(() => dec(blobLen(3, p)), /DiocomReactor/);
        const { payload, expected } = specProgram();
        const b = blob(expected, payload);
        b[13] ^= 1;
        rejects(b, /CRC/);
        const bomb = payloadOf([FILL, ...vi(2 ** 40), 0]);
        assert.throws(() => dec(blobLen(2 ** 40, bomb), 64 << 20), /exceeds limit/);
        rejects(blobLen(1024, bomb), /FILL op exceeds/);
        const many = [FILL, 1, 0];
        for (let i = 0; i < 10_000; i++) many.push(REP, 1, 0x80, 0x80, 0x01);
        rejects(blobLen(1 << 20, payloadOf(many)), /REPEAT op exceeds/);
    });
});

describe('procedural fuzz', { skip }, () => {
    test('2000 corruptions throw or decode exactly', () => {
        const r = prng(0x5eed05);
        const seeds: Array<{ data: Buffer; blob: Buffer }> = [];
        for (const [filter, stride] of [['none', 0], ['delta', 4], ['shuffle', 2], ['delta', 1]] as Array<[V2Filter, number]>) {
            const data = mixed(10 + stride).subarray(0, 12_000 + stride * 1000);
            seeds.push({ data, blob: DiocomReactor.encodeV2(data, { codec: 'procedural', filter, stride }) });
        }
        const { payload, expected } = specProgram();
        seeds.push({ data: expected, blob: blob(expected, payload) });
        let threw = 0;
        let exact = 0;
        for (let i = 0; i < 2000; i++) {
            const { data, blob: b0 } = seeds[i % seeds.length];
            let c = Buffer.from(b0);
            const kind = r() % 6;
            if (kind === 0) {
                for (let k = 0, m = 1 + (r() % 4); k < m; k++) c[r() % c.length] ^= 1 << (r() % 8);
            } else if (kind === 1) {
                c[r() % V2_HEADER_SIZE] = r() & 0xff;
            } else if (kind === 2) {
                c = c.subarray(0, 1 + (r() % (c.length - 1)));
            } else if (kind === 3) {
                c = Buffer.concat([c, randomBytes(1 + (r() % 32), r())]);
            } else if (kind === 4) {
                // program bytes
                const span = Math.min(40, c.length - V2_HEADER_SIZE);
                for (let k = 0; k <= r() % 3; k++) c[V2_HEADER_SIZE + (r() % span)] = r() & 0xff;
            } else {
                c[V2_HEADER_SIZE + (r() % (c.length - V2_HEADER_SIZE))] = r() & 0xff;
            }
            let out: Buffer;
            try {
                out = dec(c, 32 << 20);
            } catch (e) {
                assert.ok(e instanceof Error);
                threw++;
                continue;
            }
            assert.ok(out.equals(data), `corruption #${i} (kind ${kind}) decoded to different bytes`);
            exact++;
            // raw payload decoder with an arbitrary claimed length never crashes the process either
            try { proceduralDecode(c.subarray(V2_HEADER_SIZE), r() % 100_000); } catch { /* expected */ }
        }
        assert.equal(threw + exact, 2000);
        assert.ok(threw > 1500, `threw ${threw}`);
    });

    test('raw payload decoder: random payloads only ever throw Errors', () => {
        const r = prng(77);
        for (let i = 0; i < 2000; i++) {
            const p = randomBytes(1 + (r() % 64), r());
            try { proceduralDecode(p, r() % 4096); } catch (e) { assert.ok(e instanceof Error); }
        }
    });

    test('TS encoder output also round-trips through the raw decoder', () => {
        const d = mixed(3);
        assert.ok(proceduralDecode(proceduralEncode(d, 3), d.length).equals(d));
    });
});
