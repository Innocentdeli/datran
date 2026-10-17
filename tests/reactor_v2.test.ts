import { test, describe } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
    DiocomReactor, DictionaryUnavailableError, ReactorRecipe, V2Codec, V2Filter, V2_HEADER_SIZE,
    applyFilter, invertFilter, crc32, lz4DecodeBlock, lz4EncodeBlock,
} from '../src/core/DiocomReactor';

DiocomReactor.verbose = false;
const V2_FIXTURES = path.join(__dirname, '..', 'core-reactor', 'tests', 'fixtures', 'v2');
const HAS_ZSTD = typeof (zlib as any).zstdCompressSync === 'function';

function prng(seed: number) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 8; };
}

const gen: Record<string, (n: number) => Buffer> = {
    random: (n) => crypto.randomBytes(n),
    zeros: (n) => Buffer.alloc(n),
    text: (n) => {
        const words = ['alpha ', 'beta ', 'gamma ', '{"id": ', '"reactor", ', 'datran\n'];
        const r = prng(n + 7); let s = '';
        while (s.length < n) s += words[r() % words.length] + (r() % 4 === 0 ? (r() % 1000) + ' ' : '');
        return Buffer.from(s).subarray(0, n);
    },
    // little-endian u32 counter: delta/shuffle friendly
    u32ramp: (n) => { const b = Buffer.alloc(n); for (let i = 0; i + 4 <= n; i += 4) b.writeUInt32LE((i / 4) * 3 + 1000, i); return b; },
    f64: (n) => { const b = Buffer.alloc(n); for (let i = 0; i + 8 <= n; i += 8) b.writeDoubleLE(Math.sin(i / 80) * 100, i); return b; },
};
const SIZES = [0, 1, 7, 13, 1000, 70_001];
const CODECS: V2Codec[] = HAS_ZSTD ? ['raw', 'lz4', 'deflate', 'zstd', 'brotli', 'procedural'] : ['raw', 'lz4', 'deflate', 'brotli'];
const FILTERS: Array<[V2Filter, number]> = [['none', 0], ['delta', 1], ['delta', 2], ['delta', 4], ['delta', 8], ['shuffle', 1], ['shuffle', 2], ['shuffle', 4], ['shuffle', 8]];

const noDict = () => null;
const dec = (b: Buffer, opts: Parameters<typeof DiocomReactor.decompress>[1] = {}) =>
    DiocomReactor.decompress(b, { dictionaryResolver: noDict, ...opts });

describe('v2 filters', () => {
    test('delta known vector (wrapping)', () => {
        const input = Buffer.from([1, 3, 6, 10, 5, 0]);
        assert.deepEqual([...applyFilter(input, 'delta', 1)], [1, 2, 3, 4, 251, 251]);
        assert.deepEqual([...applyFilter(input, 'delta', 2)], [1, 3, 5, 7, 255, 246]);
    });
    test('shuffle known vector with tail', () => {
        const input = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        // stride 4: m = 2; tail [8, 9]
        assert.deepEqual([...applyFilter(input, 'shuffle', 4)], [0, 4, 1, 5, 2, 6, 3, 7, 8, 9]);
        // stride 8: m = 1
        assert.deepEqual([...applyFilter(input, 'shuffle', 8)], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
    test('filters invert exactly (all strides, many lengths)', () => {
        for (const [f, s] of FILTERS) {
            for (const n of [0, 1, 2, 3, 7, 8, 9, 15, 16, 17, 1001]) {
                const data = crypto.randomBytes(n);
                assert.deepEqual(invertFilter(applyFilter(data, f, s), f, s), data, `${f}/${s}/${n}`);
            }
        }
    });
    test('invalid strides throw', () => {
        assert.throws(() => applyFilter(Buffer.alloc(4), 'delta', 3));
        assert.throws(() => applyFilter(Buffer.alloc(4), 'shuffle', 0));
        assert.throws(() => applyFilter(Buffer.alloc(4), 'none', 1));
    });
    test('crc32 matches IEEE check value', () => {
        assert.equal(crc32(Buffer.from('123456789')), 0xCBF43926);
    });
});

describe('v2 lz4 block encoder', () => {
    test('round-trips through the block decoder', () => {
        for (const [name, fn] of Object.entries(gen)) {
            for (const n of [1, 12, 13, 100, 65_536, 200_000]) {
                const d = fn(n);
                assert.deepEqual(lz4DecodeBlock(lz4EncodeBlock(d), n), d, `${name}/${n}`);
            }
        }
    });
});

describe('v2 round-trip: codecs x filters x strides', () => {
    for (const codec of CODECS) {
        test(codec, () => {
            for (const [filter, stride] of FILTERS) {
                for (const [name, fn] of Object.entries(gen)) {
                    for (const n of SIZES) {
                        const data = fn(n);
                        const recipe: ReactorRecipe = { codec, filter, stride, level: codec === 'brotli' ? 4 : codec === 'zstd' ? 3 : 6 };
                        const blob = DiocomReactor.encodeV2(data, recipe);
                        assert.equal(blob[0], 0x10);
                        assert.deepEqual(dec(blob), data, `${codec}/${filter}${stride}/${name}/${n}`);
                    }
                }
            }
        });
    }
    test('window_log and levels', { skip: !HAS_ZSTD && 'Node lacks zstd' }, () => {
        const data = gen.text(300_000);
        for (const r of [
            { codec: 'zstd', level: 19, window_log: 10 }, { codec: 'zstd', level: 1, window_log: 27 },
            { codec: 'brotli', level: 11, window_log: 10 }, { codec: 'brotli', level: 0, window_log: 24 },
            { codec: 'deflate', level: 0 }, { codec: 'deflate', level: 9 },
        ] as const) {
            assert.deepEqual(dec(DiocomReactor.encodeV2(data, { ...r, filter: 'none', stride: 0 })), data, JSON.stringify(r));
        }
    });
});

describe('v2 zstd dictionaries', { skip: !HAS_ZSTD && 'Node lacks zstd' }, () => {
    const dict = Buffer.from(Array.from({ length: 200 }, (_, i) => `{"user":"u${i}","status":"active","plan":"pro"}`).join('\n'));
    const dictId = crypto.createHash('sha256').update(dict).digest('hex');
    const data = Buffer.from('{"user":"u42","status":"active","plan":"pro"}\n{"user":"u7","status":"active","plan":"pro"}');

    test('round-trip with resolver; dictionary helps', () => {
        const blob = DiocomReactor.encodeV2(data, { codec: 'zstd', level: 9, filter: 'none', stride: 0, dict: dictId }, dict);
        assert.equal(blob.subarray(17, 49).toString('hex'), dictId);
        const plain = DiocomReactor.encodeV2(data, { codec: 'zstd', level: 9, filter: 'none', stride: 0 });
        assert.ok(blob.length < plain.length);
        assert.deepEqual(DiocomReactor.decompress(blob, { dictionaryResolver: (id) => (id === dictId ? dict : null) }), data);
    });
    test('missing dictionary -> DictionaryUnavailableError', () => {
        const blob = DiocomReactor.encodeV2(data, { codec: 'zstd', filter: 'delta', stride: 1 }, dict);
        assert.throws(() => dec(blob), DictionaryUnavailableError);
    });
    test('resolver returning wrong bytes is rejected', () => {
        const blob = DiocomReactor.encodeV2(data, { codec: 'zstd', filter: 'none', stride: 0 }, dict);
        assert.throws(() => DiocomReactor.decompress(blob, { dictionaryResolver: () => Buffer.from('nope') }), DictionaryUnavailableError);
    });
    test('default resolver reads REACTOR_STATE_DIR/dicts/<sha>.dict and verifies it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reactor-state-'));
        const prev = process.env.REACTOR_STATE_DIR;
        try {
            process.env.REACTOR_STATE_DIR = dir;
            const blob = DiocomReactor.encodeV2(data, { codec: 'zstd', filter: 'none', stride: 0 }, dict);
            assert.throws(() => DiocomReactor.decompress(blob), DictionaryUnavailableError);
            fs.mkdirSync(path.join(dir, 'dicts'));
            fs.writeFileSync(path.join(dir, 'dicts', `${dictId}.dict`), Buffer.concat([dict, Buffer.from('x')])); // tampered
            assert.throws(() => DiocomReactor.decompress(blob), DictionaryUnavailableError);
            fs.writeFileSync(path.join(dir, 'dicts', `${dictId}.dict`), dict);
            assert.deepEqual(DiocomReactor.decompress(blob), data);
        } finally {
            if (prev === undefined) delete process.env.REACTOR_STATE_DIR; else process.env.REACTOR_STATE_DIR = prev;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('v2 decoder rejection rules', () => {
    const data = gen.text(5000);
    const base = DiocomReactor.encodeV2(data, { codec: 'deflate', level: 6, filter: 'delta', stride: 2 });
    const mut = (b: Buffer, f: (c: Buffer) => void) => { const c = Buffer.from(b); f(c); return c; };
    const rejects = (b: Buffer, re: RegExp, opts = {}) => assert.throws(() => dec(b, opts), re);

    test('sanity: base decodes', () => assert.deepEqual(dec(base), data));
    test('truncated header', () => { for (let n = 1; n < V2_HEADER_SIZE; n++) rejects(base.subarray(0, n), /shorter than header/); });
    test('unknown version', () => { rejects(mut(base, c => { c[1] = 0; }), /version/); rejects(mut(base, c => { c[1] = 2; }), /version/); });
    test('unknown codec', () => { for (const id of [6, 7, 255]) rejects(mut(base, c => { c[2] = id; }), /codec/); });
    test('unknown filter', () => rejects(mut(base, c => { c[3] = 3; }), /filter/));
    test('stride not in {1,2,4,8}', () => { for (const s of [0, 3, 5, 16, 255]) rejects(mut(base, c => { c[4] = s; }), /stride/); });
    test('filter none with stride != 0', () => {
        const b = DiocomReactor.encodeV2(data, { codec: 'raw', filter: 'none', stride: 0 });
        rejects(mut(b, c => { c[4] = 1; }), /stride/);
    });
    test('dictionary on non-zstd codec', () => {
        for (const codec of ['raw', 'lz4', 'deflate', 'brotli'] as V2Codec[]) {
            const b = DiocomReactor.encodeV2(data, { codec, filter: 'none', stride: 0 });
            rejects(mut(b, c => { c[30] = 1; }), /non-zstd/);
        }
    });
    test('original length > max output', () => {
        rejects(base, /exceeds limit/, { maxOutputBytes: 4999 });
        rejects(mut(base, c => c.writeBigUInt64LE(0xFFFFFFFFFFFFFFFFn, 5)), /exceeds limit/);
        assert.deepEqual(dec(base, { maxOutputBytes: 5000 }), data);
    });
    test('decoded length != original length', () => {
        rejects(mut(base, c => c.writeBigUInt64LE(4999n, 5)), /original length|exceeds original/);
        rejects(mut(base, c => c.writeBigUInt64LE(5001n, 5)), /length/);
        const raw = DiocomReactor.encodeV2(data, { codec: 'raw', filter: 'none', stride: 0 });
        rejects(raw.subarray(0, raw.length - 1), /length/);
        rejects(Buffer.concat([raw, Buffer.from([0])]), /length/);
        for (const codec of CODECS.filter(c => c !== 'raw')) {
            const b = DiocomReactor.encodeV2(data, { codec, filter: 'none', stride: 0 });
            assert.throws(() => dec(mut(b, c => c.writeBigUInt64LE(5003n, 5))), /DiocomReactor/, codec);
        }
    });
    test('CRC mismatch', () => {
        rejects(mut(base, c => { c[13] ^= 1; }), /CRC/);
        const raw = DiocomReactor.encodeV2(data, { codec: 'raw', filter: 'shuffle', stride: 4 });
        rejects(mut(raw, c => { c[100] ^= 0x80; }), /CRC/);
    });
    test('unknown dictionary', { skip: !HAS_ZSTD && 'Node lacks zstd' }, () => {
        const b = DiocomReactor.encodeV2(data, { codec: 'zstd', filter: 'none', stride: 0 });
        assert.throws(() => dec(mut(b, c => { c[17] = 0xAB; })), DictionaryUnavailableError);
    });
    test('trailing bytes after the compressed stream', () => {
        for (const codec of CODECS.filter(c => c !== 'raw')) {
            const b = DiocomReactor.encodeV2(data, { codec, filter: 'none', stride: 0 });
            assert.throws(() => dec(Buffer.concat([b, Buffer.from([1, 2, 3])])), /DiocomReactor/, codec);
        }
    });
    test('garbage payloads throw for every codec', () => {
        for (const codec of CODECS) {
            const b = DiocomReactor.encodeV2(data, { codec, filter: 'none', stride: 0 });
            const g = Buffer.concat([b.subarray(0, V2_HEADER_SIZE), crypto.randomBytes(64)]);
            assert.throws(() => dec(g), /DiocomReactor/, codec);
        }
    });
});

describe('v2 fuzz: random corruptions throw or decode exactly', () => {
    test('2000 corruptions', () => {
        const r = prng(0xC0FFEE);
        const samples: Array<{ data: Buffer; blob: Buffer }> = [];
        for (const codec of CODECS) {
            for (const [filter, stride] of [['none', 0], ['delta', 4], ['shuffle', 2]] as Array<[V2Filter, number]>) {
                const data = (r() & 1 ? gen.text : gen.u32ramp)(500 + (r() % 3000));
                samples.push({ data, blob: DiocomReactor.encodeV2(data, { codec, filter, stride }) });
            }
        }
        let threw = 0; let exact = 0;
        for (let i = 0; i < 2000; i++) {
            const { data, blob } = samples[i % samples.length];
            let c = Buffer.from(blob);
            const kind = r() % 5;
            if (kind === 0) { // flip random bits
                for (let k = 0, m = 1 + (r() % 4); k < m; k++) c[r() % c.length] ^= 1 << (r() % 8);
            } else if (kind === 1) { // header byte overwrite
                c[r() % V2_HEADER_SIZE] = r() & 0xFF;
            } else if (kind === 2) { // truncate (an empty input is the legacy "empty container" and decodes to b'')
                c = c.subarray(0, 1 + (r() % (c.length - 1)));
            } else if (kind === 3) { // append junk
                c = Buffer.concat([c, crypto.randomBytes(1 + (r() % 32))]);
            } else { // payload byte overwrite
                if (c.length > V2_HEADER_SIZE) c[V2_HEADER_SIZE + (r() % (c.length - V2_HEADER_SIZE))] = r() & 0xFF;
            }
            let out: Buffer | null = null;
            try {
                out = dec(c, { maxOutputBytes: 16 * 1024 * 1024 });
            } catch (e) {
                assert.ok(e instanceof Error, 'must throw an Error');
                threw++;
                continue;
            }
            // Any successful decode of a blob that still carries the original header must reproduce the data.
            // (Corruptions that rewrite the header could in principle describe a different valid blob; the CRC makes
            //  that astronomically unlikely, so we require exactness for all of them.)
            assert.deepEqual(out, data, `corruption #${i} (kind ${kind}) decoded to different bytes`);
            exact++;
        }
        assert.equal(threw + exact, 2000);
        assert.ok(threw > 1000, `expected most corruptions to be rejected, got ${threw}`);
    });
});

// ---------------- Cross-language fixtures (generated by core-reactor) ----------------

interface FixtureEntry { name: string; blob: string; original: string; dict?: string | null }

function loadManifest(): FixtureEntry[] | null {
    const file = path.join(V2_FIXTURES, 'MANIFEST.json');
    if (!fs.existsSync(file)) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: any[] = Array.isArray(raw) ? raw : (raw.fixtures ?? raw.entries ?? raw.blobs ?? raw.cases ?? []);
    return list.map((e: any, i: number) => {
        const name = String(e.name ?? e.id ?? i);
        const blob = e.blob ?? e.encoded ?? e.file ?? e.compressed ?? e.v2 ?? `${name}.v2.bin`;
        const original = e.original ?? e.input ?? e.plain ?? `${name}.input.bin`;
        const dict = e.dict_file ?? e.dictionary ?? e.dict ?? null;
        return { name, blob, original, dict };
    });
}

describe('v2 cross-language fixtures (Rust encoder -> TS decoder)', () => {
    const entries = loadManifest();
    if (!entries) {
        test('MANIFEST.json present', { skip: `core-reactor/tests/fixtures/v2/MANIFEST.json not found yet (generated by the Rust reactor's tests)` }, () => { });
        return;
    }
    test('manifest is not empty', () => assert.ok(entries.length > 0, 'MANIFEST.json lists no fixtures'));
    const dictCandidates = (id: string, entry: FixtureEntry) => [
        entry.dict && !/^[0-9a-f]{64}$/i.test(entry.dict) ? path.join(V2_FIXTURES, entry.dict) : null,
        path.join(V2_FIXTURES, 'dicts', `${id}.dict`),
        path.join(V2_FIXTURES, `${id}.dict`),
    ].filter((p): p is string => !!p);
    for (const entry of entries) {
        test(entry.name, () => {
            const blob = fs.readFileSync(path.join(V2_FIXTURES, entry.blob));
            const original = fs.readFileSync(path.join(V2_FIXTURES, entry.original));
            const out = DiocomReactor.decompress(blob, {
                dictionaryResolver: (id) => {
                    for (const p of dictCandidates(id, entry)) if (fs.existsSync(p)) return fs.readFileSync(p);
                    return null;
                },
            });
            assert.ok(out.equals(original), `${entry.name}: decoded bytes differ from original`);
        });
    }
});
