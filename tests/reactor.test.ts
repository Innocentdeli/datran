import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import { DiocomReactor, lz4DecodeBlock } from '../src/core/DiocomReactor';
import { GenomeGenerator, REVERSIBLE_ALGORITHMS } from '../src/core/GenomeGenerator';
import { compressFile } from '../src/tool/compress_real';
import { decompressFile } from '../src/tool/decompress_real';
import { ACS_ALGO, ACS_HEADER_SIZE } from '../src/tool/acs_format';

DiocomReactor.verbose = false;
const FIXTURES = path.join(__dirname, '..', 'core-reactor', 'tests', 'fixtures');

// ---------- data generators (deterministic) ----------
function prng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
}
const gen = {
    random: (n: number) => crypto.randomBytes(n),
    zeros: (n: number) => Buffer.alloc(n),
    text: (n: number) => {
        const words = ['alpha ', 'beta ', 'gamma ', 'delta ', 'reactor ', 'datran\n'];
        const r = prng(n + 1); const parts: string[] = []; let len = 0;
        while (len < n) { const w = words[r() % words.length] + (r() % 5 === 0 ? r() + ' ' : ''); parts.push(w); len += w.length; }
        return Buffer.from(parts.join('')).subarray(0, n);
    },
    repeating: (n: number) => { const p = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!?'); return Buffer.from(Array.from({ length: n }, (_, i) => p[i % p.length])); },
    twoSym: (n: number) => { const r = prng(2); return Buffer.from(Array.from({ length: n }, () => (r() & 1 ? 0x41 : 0x42))); },
    fourSym: (n: number) => { const r = prng(4); return Buffer.from(Array.from({ length: n }, () => 0x61 + (r() & 3))); },
    sixteenSkewed: (n: number) => { const r = prng(16); return Buffer.from(Array.from({ length: n }, (_, i) => (i % 13 === 0 ? 0x30 + (r() & 15) : 0x30 + (r() & 1)))); },
};
const SIZES = [0, 1, 2, 7, 8, 9, 255, 4096, 65_537, 1 << 20];

describe('DiocomReactor round-trip (TS encoder -> TS decoder)', () => {
    for (const [name, fn] of Object.entries(gen)) {
        test(`${name}`, () => {
            for (const n of SIZES) {
                const input = fn(n);
                const c = DiocomReactor.compress(input);
                assert.ok(c.length <= input.length + 1, `${name}/${n}: expansion ${c.length}`);
                const d = DiocomReactor.decompress(c);
                assert.ok(d.equals(input), `${name}/${n}: mismatch`);
            }
        });
    }

    test('uses each TS-emitted format', () => {
        assert.equal(DiocomReactor.compress(Buffer.alloc(0))[0], DiocomReactor.FLAG_RAW);
        assert.equal(DiocomReactor.compress(gen.random(10_000))[0], DiocomReactor.FLAG_RAW);
        assert.equal(DiocomReactor.compress(gen.zeros(10_000))[0], DiocomReactor.FLAG_SYMBIT);
        assert.equal(DiocomReactor.compress(gen.sixteenSkewed(10_000))[0], DiocomReactor.FLAG_SYMBIT);
        assert.equal(DiocomReactor.compress(gen.text(10_000))[0], DiocomReactor.FLAG_ZLIB);
        assert.deepEqual(DiocomReactor.decompress(Buffer.alloc(0)), Buffer.alloc(0));
    });
});

describe('Rust-produced fixtures decode in TS', () => {
    const files = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter(f => f.endsWith('.rs.bin')) : [];
    test('fixtures exist (regenerate: REACTOR_WRITE_FIXTURES=1 cargo test write_fixtures)', () => {
        assert.ok(files.length >= 10, `found ${files.length} fixtures in ${FIXTURES}`);
        const flags = new Set(files.map(f => fs.readFileSync(path.join(FIXTURES, f))[0]));
        for (const flag of [0, 1, 2, 3]) assert.ok(flags.has(flag), `no fixture with flag ${flag}`);
    });
    for (const f of files) {
        test(f, () => {
            const encoded = fs.readFileSync(path.join(FIXTURES, f));
            const expected = fs.readFileSync(path.join(FIXTURES, f.replace('.rs.bin', '.input.bin')));
            const decoded = DiocomReactor.decompress(encoded);
            assert.ok(decoded.equals(expected), `${f}: decoded ${decoded.length} bytes, expected ${expected.length}`);
        });
    }

    // Writes TS-encoded fixtures that the Rust test `decodes_ts_fixtures` checks.
    test('write TS fixtures for Rust (WRITE_TS_FIXTURES=1)', { skip: !process.env.WRITE_TS_FIXTURES }, () => {
        const cases: Record<string, Buffer> = {
            ts_zeros: gen.zeros(5000), ts_two: gen.twoSym(5001), ts_four: gen.fourSym(5003),
            ts_sixteen: gen.sixteenSkewed(5005), ts_text: gen.text(50_000), ts_random: gen.random(4096), ts_one: Buffer.from([9]),
        };
        for (const [name, data] of Object.entries(cases)) {
            fs.writeFileSync(path.join(FIXTURES, `${name}.input.bin`), data);
            fs.writeFileSync(path.join(FIXTURES, `${name}.ts.bin`), DiocomReactor.compress(data));
        }
    });
});

function symbit(bitWidth: number, total: number, dict: number[], packed: number[]): Buffer {
    const h = Buffer.alloc(7);
    h[0] = 0x00; h[1] = bitWidth; h.writeUInt32BE(total >>> 0, 2); h[6] = (dict.length - 1) & 0xff;
    return Buffer.concat([h, Buffer.from(dict), Buffer.from(packed)]);
}

describe('malformed input throws', () => {
    test('unknown flag', () => assert.throws(() => DiocomReactor.decompress(Buffer.from([0x09, 1, 2]))));

    test('symbit: bad bit widths', () => {
        for (const bw of [0, 3, 8, 9, 255]) {
            assert.throws(() => DiocomReactor.decompress(symbit(bw, 8, [1, 2], [0, 0, 0, 0, 0, 0, 0, 0])), undefined, `bw ${bw}`);
        }
    });
    test('symbit: huge total_items / over limit / truncated / short header', () => {
        assert.throws(() => DiocomReactor.decompress(symbit(1, 0xFFFFFFFF, [1, 2], [0xAA, 0xAA])));
        const ok = symbit(1, 64, [1, 2], Array(8).fill(0xAA));
        assert.equal(DiocomReactor.decompress(ok, { maxOutputBytes: 64 }).length, 64);
        assert.throws(() => DiocomReactor.decompress(ok, { maxOutputBytes: 63 }));
        assert.throws(() => DiocomReactor.decompress(symbit(2, 100, [1, 2, 3, 4], Array(10).fill(0x1B))));
        assert.throws(() => DiocomReactor.decompress(Buffer.from([0x00, 1, 0])));
        assert.throws(() => DiocomReactor.decompress(Buffer.from([0x00, 4, 0, 0, 0, 1, 15, 1])));
    });
    test('symbit: dictionary larger than code space / code outside dictionary', () => {
        assert.throws(() => DiocomReactor.decompress(symbit(1, 0, [1, 2, 3], [])));
        assert.throws(() => DiocomReactor.decompress(symbit(2, 4, [1, 2, 3], [0xFF])));
    });

    test('lz4: truncations, lying size, bad offset, over limit', () => {
        const good = fs.readFileSync(path.join(FIXTURES, 'lz4_forced_text.rs.bin'));
        assert.equal(good[0], DiocomReactor.FLAG_LZ4);
        for (const cut of [1, 3, 5, 100, good.length >> 1, good.length - 1]) {
            assert.throws(() => DiocomReactor.decompress(good.subarray(0, cut)), undefined, `cut ${cut}`);
        }
        const big = Buffer.from(good); big.writeUInt32LE(0xFFFFFFFF, 1);
        assert.throws(() => DiocomReactor.decompress(big));
        const small = Buffer.from(good); small.writeUInt32LE(10, 1);
        assert.throws(() => DiocomReactor.decompress(small));
        assert.throws(() => DiocomReactor.decompress(good, { maxOutputBytes: good.readUInt32LE(1) - 1 }));
        // literal 'a' then a match at offset 5 (> bytes written)
        assert.throws(() => lz4DecodeBlock(Buffer.from([0x10, 0x61, 0x05, 0x00]), 10));
        assert.throws(() => lz4DecodeBlock(Buffer.from([0x10, 0x61, 0x00, 0x00]), 10)); // offset 0
        assert.throws(() => DiocomReactor.decompress(Buffer.from([0x03, 5, 0, 0, 0, 0xFF, 0xFF])));
    });

    test('lz4: random corruption never crashes', () => {
        const good = fs.readFileSync(path.join(FIXTURES, 'lz4_forced_small.rs.bin'));
        const r = prng(77);
        for (let i = 0; i < 2000; i++) {
            const bad = Buffer.from(good);
            bad[1 + (r() % (bad.length - 1))] = r();
            try { DiocomReactor.decompress(bad); } catch (e) { assert.ok(e instanceof Error); }
        }
    });

    test('deflate: garbage, truncation, bomb over limit', () => {
        assert.throws(() => DiocomReactor.decompress(Buffer.from([0x01, 0xFF, 0xFF, 0xFF])));
        const good = DiocomReactor.compress(gen.text(50_000));
        assert.throws(() => DiocomReactor.decompress(good.subarray(0, good.length >> 1)));
        const bomb = Buffer.concat([Buffer.from([0x01]), zlib.deflateRawSync(Buffer.alloc(64 << 20))]);
        assert.ok(bomb.length < 1 << 20);
        assert.throws(() => DiocomReactor.decompress(bomb, { maxOutputBytes: 1 << 20 }), /exceeds limit/);
    });
});

describe('GenomeGenerator', () => {
    test('default variants are all reversible and decode exactly', () => {
        const pattern = Buffer.from('Middle-Out Compression Algorithm');
        const data = Buffer.alloc(200_000);
        for (let i = 0; i < data.length; i += pattern.length) pattern.copy(data, i);
        const variants = GenomeGenerator.generateVariants('c1', data);
        assert.ok(variants.some(v => v.algorithm === 'reactor'));
        for (const v of variants) {
            assert.ok(REVERSIBLE_ALGORITHMS.has(v.algorithm), `lossy variant ${v.algorithm} produced by default`);
            assert.ok(GenomeGenerator.decodeVariant(v).equals(data), `${v.algorithm} does not round-trip`);
        }
        const sim = GenomeGenerator.generateVariants('c1', data, undefined, { includeSimulated: true });
        const lossy = sim.filter(v => !REVERSIBLE_ALGORITHMS.has(v.algorithm));
        assert.ok(lossy.length > 0);
        for (const v of lossy) assert.throws(() => GenomeGenerator.decodeVariant(v));
    });
});

describe('compress_real -> decompress_real', () => {
    const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
        const log = console.log, warn = console.warn, write = process.stdout.write;
        console.log = () => { }; console.warn = () => { }; (process.stdout as any).write = () => true;
        try { return await fn(); } finally { console.log = log; console.warn = warn; (process.stdout as any).write = write; }
    };

    test('lossless round-trip with SHA-256 verification; corruption and generative chunks rejected', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-test-'));
        try {
            const input = Buffer.concat([gen.random(700_000), gen.zeros(1_200_000), gen.text(900_000), gen.repeating(300_000), gen.twoSym(5)]);
            const src = path.join(dir, 'in.bin');
            fs.writeFileSync(src, input);
            const acs = await quiet(() => compressFile(src, path.join(dir, 'in.bin.acs')));
            assert.ok(fs.statSync(acs).size < input.length);
            const out = await quiet(() => decompressFile(acs, path.join(dir, 'out.bin')));
            assert.ok(fs.readFileSync(out).equals(input));

            // Flip a byte in the stored SHA-256: must fail and leave no output.
            const corrupt = Buffer.from(fs.readFileSync(acs)); corrupt[20] ^= 0xFF;
            fs.writeFileSync(path.join(dir, 'bad.acs'), corrupt);
            await assert.rejects(quiet(() => decompressFile(path.join(dir, 'bad.acs'), path.join(dir, 'bad.out'))), /SHA-256 mismatch/);
            assert.ok(!fs.existsSync(path.join(dir, 'bad.out')));

            // Rewrite the first chunk's algo id to the lossy generative stub: must throw.
            const gen3 = Buffer.from(fs.readFileSync(acs)); gen3[ACS_HEADER_SIZE] = ACS_ALGO.GENERATIVE;
            fs.writeFileSync(path.join(dir, 'gen.acs'), gen3);
            await assert.rejects(quiet(() => decompressFile(path.join(dir, 'gen.acs'), path.join(dir, 'gen.out'))), /generative/);

            // Empty file
            fs.writeFileSync(path.join(dir, 'empty.bin'), Buffer.alloc(0));
            const eAcs = await quiet(() => compressFile(path.join(dir, 'empty.bin')));
            const eOut = await quiet(() => decompressFile(eAcs, path.join(dir, 'empty.out')));
            assert.equal(fs.statSync(eOut).size, 0);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
