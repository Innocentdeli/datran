
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * THE DIOCOM REACTOR (TypeScript fallback)
 *
 * Byte-compatible with core-reactor (Rust). Every container starts with a 1-byte flag:
 *   0x00 SYMBIT  BitWidth(1: 1|2|4) | TotalItems(u32 BE) | MapSize-1 (1) | Map | packed codes (MSB-first)
 *   0x01 DEFLATE raw deflate stream (no zlib header)
 *   0x02 RAW     payload verbatim
 *   0x03 LZ4     u32 LE uncompressed size | LZ4 block (lz4_flex::compress_prepend_size)
 *   0x10 RECIPE  blob v2 (core-reactor/docs/EVOLUTION_SPEC.md §1): decode only; encodeV2() exists for tests/tools.
 *                Codec 5 = procedural (core-reactor/docs/NETWORK_SPEC.md §1), see proceduralDecode().
 *
 * Adaptive Entropy-Based Compression:
 * - Raw Passthrough (entropy >= 7.8)
 * - Symbit Packing (entropy < 3.0, <= 16 distinct bytes)
 * - Raw Deflate otherwise (or raw if nothing helps)
 *
 * decompress() understands all four formats and throws on malformed input.
 */

export interface ReactorDecodeOptions {
    /** Maximum decompressed size in bytes. Defaults to REACTOR_MAX_OUTPUT_BYTES or 2 GiB. */
    maxOutputBytes?: number;
    /**
     * Resolves a zstd dictionary by its SHA-256 (lower-case hex) for v2 blobs. Return null if unknown.
     * Defaults to reading `<state dir>/dicts/<sha256>.dict` (see defaultDictionaryResolver).
     * Returned bytes are always verified against the id.
     */
    dictionaryResolver?: (sha256Hex: string) => Buffer | null;
}

// ---------------------------------------------------------------------------
// Blob v2 (FLAG_RECIPE)
// ---------------------------------------------------------------------------

export type V2Codec = 'raw' | 'lz4' | 'deflate' | 'zstd' | 'brotli' | 'procedural';
export type V2Filter = 'none' | 'delta' | 'shuffle';

/** Recipe as in EVOLUTION_SPEC §2. */
export interface ReactorRecipe {
    codec: V2Codec;
    level?: number | null;
    window_log?: number | null;
    filter: V2Filter;
    stride: number;
    dict?: string | null;
}

export const V2_HEADER_SIZE = 49;
export const V2_CODECS: readonly V2Codec[] = ['raw', 'lz4', 'deflate', 'zstd', 'brotli', 'procedural'];
export const V2_FILTERS: readonly V2Filter[] = ['none', 'delta', 'shuffle'];
const V2_STRIDES = [1, 2, 4, 8];

/** Thrown when a v2 blob needs a zstd dictionary that is not available locally. */
export class DictionaryUnavailableError extends Error {
    constructor(public readonly dictId: string, detail?: string) {
        super(`DiocomReactor: zstd dictionary ${dictId} unavailable${detail ? ` (${detail})` : ''}`);
        this.name = 'DictionaryUnavailableError';
    }
}

/** Candidate reactor state directories, most specific first. */
export function reactorStateDirCandidates(): string[] {
    const out: string[] = [];
    const env = process.env.REACTOR_STATE_DIR;
    const cwd = process.cwd();
    const repoCandidates: string[] = [];
    // __dirname is unreliable once bundled (Next.js), so also probe from the working directory.
    if (typeof __dirname === 'string') repoCandidates.push(path.resolve(__dirname, '..', '..', 'core-reactor'));
    repoCandidates.push(path.resolve(cwd, 'core-reactor'), path.resolve(cwd, '..', 'core-reactor'));
    if (env) {
        if (path.isAbsolute(env)) return [env];
        // Relative paths are relative to the reactor's working directory (core-reactor/) or ours.
        out.push(path.resolve(cwd, env));
        for (const c of repoCandidates) out.push(path.resolve(c, env));
    } else {
        for (const c of repoCandidates) out.push(path.join(c, 'reactor-state'));
    }
    return Array.from(new Set(out));
}

const dictCache = new Map<string, Buffer>();

/** Reads `<state dir>/dicts/<sha256>.dict`, verifying its SHA-256. Returns null when absent or mismatched. */
export function defaultDictionaryResolver(sha256Hex: string): Buffer | null {
    if (!/^[0-9a-f]{64}$/.test(sha256Hex)) return null;
    const cached = dictCache.get(sha256Hex);
    if (cached) return cached;
    for (const dir of reactorStateDirCandidates()) {
        const file = path.join(dir, 'dicts', `${sha256Hex}.dict`);
        let bytes: Buffer;
        try {
            bytes = fs.readFileSync(file);
        } catch {
            continue;
        }
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== sha256Hex) {
            console.error(`[REACTOR] Dictionary ${file} does not match its SHA-256; ignoring.`);
            continue;
        }
        dictCache.set(sha256Hex, bytes);
        return bytes;
    }
    return null;
}

// Node typings in this repo predate zlib zstd; access it dynamically and feature-detect.
type ZstdFn = (buf: Buffer, opts?: Record<string, unknown>) => Buffer;
const zlibAny = zlib as unknown as Record<string, any>;

function zstdFn(name: 'zstdCompressSync' | 'zstdDecompressSync'): ZstdFn {
    const fn = zlibAny[name];
    if (typeof fn !== 'function') {
        throw new Error(`DiocomReactor: zstd is not supported by this Node.js runtime (${process.version}); Node >= 22.15 required`);
    }
    return fn as ZstdFn;
}

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

/** CRC-32 (IEEE), identical to zlib crc32. Uses zlib.crc32 when available (Node >= 22.2). */
export function crc32(data: Uint8Array): number {
    if (typeof zlibAny.crc32 === 'function') return (zlibAny.crc32(data) as number) >>> 0;
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function checkStride(filter: V2Filter, stride: number) {
    if (filter === 'none') {
        if (stride !== 0) throw new Error(`DiocomReactor: filter none requires stride 0 (got ${stride})`);
    } else if (!V2_STRIDES.includes(stride)) {
        throw new Error(`DiocomReactor: invalid filter stride ${stride}`);
    }
}

/** Applies a v2 pre-filter (encode direction). Returns a new buffer. */
export function applyFilter(input: Uint8Array, filter: V2Filter, stride: number): Buffer {
    checkStride(filter, stride);
    const n = input.length;
    const out = Buffer.allocUnsafe(n);
    if (filter === 'none') {
        out.set(input);
    } else if (filter === 'delta') {
        for (let i = 0; i < n; i++) out[i] = i < stride ? input[i] : (input[i] - input[i - stride]) & 0xFF;
    } else {
        const m = Math.floor(n / stride);
        for (let b = 0; b < stride; b++) {
            for (let e = 0; e < m; e++) out[b * m + e] = input[e * stride + b];
        }
        for (let i = m * stride; i < n; i++) out[i] = input[i];
    }
    return out;
}

/** Inverts a v2 pre-filter (decode direction). Returns a new buffer. */
export function invertFilter(input: Uint8Array, filter: V2Filter, stride: number): Buffer {
    checkStride(filter, stride);
    const n = input.length;
    const out = Buffer.allocUnsafe(n);
    if (filter === 'none') {
        out.set(input);
    } else if (filter === 'delta') {
        for (let i = 0; i < n; i++) out[i] = i < stride ? input[i] : (input[i] + out[i - stride]) & 0xFF;
    } else {
        const m = Math.floor(n / stride);
        for (let b = 0; b < stride; b++) {
            for (let e = 0; e < m; e++) out[e * stride + b] = input[b * m + e];
        }
        for (let i = m * stride; i < n; i++) out[i] = input[i];
    }
    return out;
}

/** Unwraps a zlib `{ info: true }` result and rejects trailing bytes after the compressed stream. */
function consumedExactly(result: unknown, payloadLength: number): Buffer {
    const r = result as { buffer?: Buffer; engine?: { bytesWritten?: number } };
    if (!r || !Buffer.isBuffer(r.buffer)) throw new Error('DiocomReactor: unexpected zlib result');
    const consumed = r.engine?.bytesWritten;
    if (typeof consumed === 'number' && consumed !== payloadLength) {
        throw new Error(`DiocomReactor: ${payloadLength - consumed} trailing bytes after compressed stream`);
    }
    return r.buffer;
}

function isZlibSizeError(e: any): boolean {
    return !!e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError);
}

const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024 * 1024;
const LZ4_MAX_RATIO = 255;

function defaultMaxOutput(): number {
    const env = typeof process !== 'undefined' ? process.env.REACTOR_MAX_OUTPUT_BYTES : undefined;
    const parsed = env ? Number(env) : NaN;
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_OUTPUT;
}

export class DiocomReactor {

    // Header flags (must match core-reactor/src/reactor.rs)
    public static readonly FLAG_SYMBIT = 0x00;
    public static readonly FLAG_ZLIB = 0x01;
    public static readonly FLAG_RAW = 0x02;
    public static readonly FLAG_LZ4 = 0x03;
    public static readonly FLAG_RECIPE = 0x10;
    public static readonly V2_VERSION = 1;

    /** Set to false to silence routing logs. */
    public static verbose = true;

    public static calculateEntropy(data: Buffer): number {
        if (data.length === 0) return 0;
        const counts = new Uint32Array(256);
        for (let i = 0; i < data.length; i++) counts[data[i]]++;

        let entropy = 0;
        for (let i = 0; i < 256; i++) {
            if (counts[i] === 0) continue;
            const p = counts[i] / data.length;
            entropy -= p * Math.log2(p);
        }
        return entropy;
    }

    private static log(msg: string) {
        if (this.verbose) console.log(msg);
    }

    private static frame(flag: number, payload: Buffer): Buffer {
        const out = Buffer.allocUnsafe(payload.length + 1);
        out[0] = flag;
        payload.copy(out, 1);
        return out;
    }

    public static compress(data: Buffer): Buffer {
        if (data.length === 0) return Buffer.from([this.FLAG_RAW]);

        const entropy = this.calculateEntropy(data);
        this.log(`[REACTOR] 🧠 Chunk Entropy Analyzed: ${entropy.toFixed(2)} bits/byte`);

        if (entropy >= 7.8) {
            // Highly random (encrypted or already compressed). Don't waste CPU.
            this.log(`[REACTOR] Routing: RAW Pass-through (High Entropy)`);
            return this.frame(this.FLAG_RAW, data);
        }

        if (entropy < 3.0) {
            const symbit = this.compressSymbit(data);
            if (symbit && symbit.length < data.length) {
                this.log(`[REACTOR] Routing: SYMBIT Packing (Low Entropy)`);
                return symbit;
            }
        }

        const deflated = zlib.deflateRawSync(data);
        if (deflated.length < data.length) {
            this.log(`[REACTOR] Routing: ZLIB Deflation (Mid/High Entropy)`);
            return this.frame(this.FLAG_ZLIB, deflated);
        }

        this.log(`[REACTOR] Routing: RAW (incompressible)`);
        return this.frame(this.FLAG_RAW, data);
    }

    private static compressSymbit(data: Buffer): Buffer | null {
        if (data.length === 0 || data.length > 0xFFFFFFFF) return null;

        const counts = new Map<number, number>();
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            counts.set(b, (counts.get(b) || 0) + 1);
        }

        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        const map = new Uint8Array(256);
        sorted.forEach(([byte], idx) => { map[byte] = idx; });

        const uniqueCount = sorted.length;
        let bitWidth: number;
        if (uniqueCount <= 2) bitWidth = 1;
        else if (uniqueCount <= 4) bitWidth = 2;
        else if (uniqueCount <= 16) bitWidth = 4;
        else return null;

        const mapSize = sorted.length;
        const headerSize = 1 + 1 + 4 + 1 + mapSize;
        const output = Buffer.alloc(headerSize + Math.ceil((data.length * bitWidth) / 8));
        let offset = 0;

        output[offset++] = this.FLAG_SYMBIT;
        output[offset++] = bitWidth;
        output.writeUInt32BE(data.length, offset); offset += 4;
        output[offset++] = mapSize - 1;
        for (const [byte] of sorted) output[offset++] = byte;

        let currentByte = 0;
        let bitsUsed = 0;
        for (let i = 0; i < data.length; i++) {
            currentByte = (currentByte << bitWidth) | map[data[i]];
            bitsUsed += bitWidth;
            if (bitsUsed === 8) {
                output[offset++] = currentByte & 0xFF;
                currentByte = 0;
                bitsUsed = 0;
            }
        }
        if (bitsUsed > 0) {
            output[offset++] = (currentByte << (8 - bitsUsed)) & 0xFF;
        }

        return output.subarray(0, offset);
    }

    public static decompress(reactorData: Buffer, options: ReactorDecodeOptions = {}): Buffer {
        if (reactorData.length === 0) return Buffer.alloc(0);
        const limit = options.maxOutputBytes ?? defaultMaxOutput();

        const flag = reactorData[0];
        const payload = reactorData.subarray(1);

        switch (flag) {
            case this.FLAG_RAW:
                if (payload.length > limit) throw new Error('DiocomReactor: raw payload exceeds output limit');
                return payload;
            case this.FLAG_ZLIB:
                try {
                    return zlib.inflateRawSync(payload, { maxOutputLength: limit });
                } catch (e: any) {
                    if (e && (e.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError)) {
                        throw new Error(`DiocomReactor: deflate output exceeds limit of ${limit} bytes`);
                    }
                    throw new Error(`DiocomReactor: deflate decompress failed: ${e?.message ?? e}`);
                }
            case this.FLAG_LZ4:
                return this.decompressLz4(payload, limit);
            case this.FLAG_SYMBIT:
                return this.decompressSymbit(payload, limit);
            case this.FLAG_RECIPE:
                return this.decompressV2(reactorData, limit, options.dictionaryResolver ?? defaultDictionaryResolver);
            default:
                throw new Error('DiocomReactor: Unknown compression flag ' + flag);
        }
    }

    private static decompressSymbit(payload: Buffer, limit: number): Buffer {
        if (payload.length < 6) throw new Error('DiocomReactor: symbit payload too short');

        const bitWidth = payload[0];
        if (bitWidth !== 1 && bitWidth !== 2 && bitWidth !== 4) {
            throw new Error(`DiocomReactor: invalid symbit bit width ${bitWidth}`);
        }
        const totalItems = payload.readUInt32BE(1);
        const mapSize = payload[5] + 1;
        let offset = 6;

        if (mapSize > (1 << bitWidth)) throw new Error('DiocomReactor: symbit dictionary larger than code space');
        if (payload.length < offset + mapSize) throw new Error('DiocomReactor: symbit dictionary truncated');
        const dict = payload.subarray(offset, offset + mapSize);
        offset += mapSize;

        if (totalItems > limit) {
            throw new Error(`DiocomReactor: symbit item count ${totalItems} exceeds limit of ${limit} bytes`);
        }
        const packed = payload.subarray(offset);
        const needed = Math.ceil((totalItems * bitWidth) / 8);
        if (packed.length !== needed) {
            throw new Error(`DiocomReactor: symbit length mismatch (expected ${needed} packed bytes, got ${packed.length})`);
        }

        const out = Buffer.allocUnsafe(totalItems);
        const perByte = 8 / bitWidth;
        const mask = (1 << bitWidth) - 1;
        let n = 0;
        for (let i = 0; i < packed.length && n < totalItems; i++) {
            const byte = packed[i];
            for (let slot = 0; slot < perByte && n < totalItems; slot++) {
                const code = (byte >> (8 - (slot + 1) * bitWidth)) & mask;
                if (code >= mapSize) throw new Error(`DiocomReactor: symbit code ${code} outside dictionary`);
                out[n++] = dict[code];
            }
        }
        return out;
    }

    /** LZ4 block with 4-byte LE size prefix, as produced by lz4_flex::compress_prepend_size. */
    private static decompressLz4(payload: Buffer, limit: number): Buffer {
        if (payload.length < 4) throw new Error('DiocomReactor: LZ4 payload missing size prefix');
        const declared = payload.readUInt32LE(0);
        const src = payload.subarray(4);

        if (declared > limit) throw new Error(`DiocomReactor: LZ4 declared size ${declared} exceeds limit of ${limit} bytes`);
        if (declared > src.length * LZ4_MAX_RATIO + 16) throw new Error('DiocomReactor: LZ4 declared size impossible for payload length');

        return lz4DecodeBlock(src, declared);
    }

    /** Parses and validates a v2 header. Throws on any rule violation from EVOLUTION_SPEC §1. */
    public static parseV2Header(blob: Buffer, limit: number = defaultMaxOutput()) {
        if (blob.length < V2_HEADER_SIZE) throw new Error('DiocomReactor: v2 blob shorter than header');
        if (blob[0] !== this.FLAG_RECIPE) throw new Error('DiocomReactor: not a v2 blob');
        const version = blob[1];
        if (version !== this.V2_VERSION) throw new Error(`DiocomReactor: unsupported v2 format version ${version}`);
        const codec = V2_CODECS[blob[2]];
        if (!codec) throw new Error(`DiocomReactor: unknown v2 codec ${blob[2]}`);
        const filter = V2_FILTERS[blob[3]];
        if (!filter) throw new Error(`DiocomReactor: unknown v2 filter ${blob[3]}`);
        const stride = blob[4];
        checkStride(filter, stride);
        const originalLength = blob.readBigUInt64LE(5);
        if (originalLength > BigInt(limit)) {
            throw new Error(`DiocomReactor: v2 original length ${originalLength} exceeds limit of ${limit} bytes`);
        }
        const crc = blob.readUInt32LE(13);
        const dictBytes = blob.subarray(17, 49);
        const hasDict = dictBytes.some(b => b !== 0);
        if (hasDict && codec !== 'zstd') throw new Error(`DiocomReactor: dictionary set on non-zstd codec ${codec}`);
        return {
            codec,
            filter,
            stride,
            originalLength: Number(originalLength),
            crc,
            dictId: hasDict ? dictBytes.toString('hex') : null,
            payload: blob.subarray(V2_HEADER_SIZE),
        };
    }

    private static decompressV2(blob: Buffer, limit: number, resolver: (id: string) => Buffer | null): Buffer {
        const h = this.parseV2Header(blob, limit);
        const n = h.originalLength;
        const cap = Math.max(1, n); // zlib needs >= 1; any overshoot is a length mismatch anyway
        let filtered: Buffer;

        try {
            switch (h.codec) {
                case 'raw':
                    filtered = h.payload;
                    break;
                case 'lz4':
                    if (n === 0 && h.payload.length === 0) { filtered = Buffer.alloc(0); break; }
                    if (n > h.payload.length * LZ4_MAX_RATIO + 16) throw new Error('DiocomReactor: LZ4 declared size impossible for payload length');
                    filtered = lz4DecodeBlock(h.payload, n);
                    break;
                case 'deflate':
                    filtered = consumedExactly(zlib.inflateSync(h.payload, { maxOutputLength: cap, info: true } as zlib.ZlibOptions), h.payload.length);
                    break;
                case 'brotli':
                    filtered = consumedExactly(zlib.brotliDecompressSync(h.payload, { maxOutputLength: cap, info: true } as zlib.BrotliOptions), h.payload.length);
                    break;
                case 'zstd': {
                    const opts: Record<string, unknown> = { maxOutputLength: cap };
                    if (h.dictId) {
                        const dict = resolver(h.dictId);
                        if (!dict) throw new DictionaryUnavailableError(h.dictId);
                        if (crypto.createHash('sha256').update(dict).digest('hex') !== h.dictId) {
                            throw new DictionaryUnavailableError(h.dictId, 'resolver returned bytes with a different SHA-256');
                        }
                        opts.dictionary = dict;
                    }
                    opts.info = true;
                    filtered = consumedExactly(zstdFn('zstdDecompressSync')(h.payload, opts), h.payload.length);
                    break;
                }
                case 'procedural':
                    filtered = proceduralDecode(h.payload, n);
                    break;
            }
        } catch (e: any) {
            if (e instanceof DictionaryUnavailableError) throw e;
            if (isZlibSizeError(e)) throw new Error(`DiocomReactor: v2 ${h.codec} output exceeds original length ${n}`);
            const msg = e?.message ?? String(e);
            throw new Error(msg.startsWith('DiocomReactor:') ? msg : `DiocomReactor: v2 ${h.codec} decode failed: ${msg}`);
        }

        if (filtered!.length !== n) {
            throw new Error(`DiocomReactor: v2 decoded length ${filtered!.length} != original length ${n}`);
        }
        const out = h.filter === 'none' ? Buffer.from(filtered!) : invertFilter(filtered!, h.filter, h.stride);
        const actual = crc32(out);
        if (actual !== h.crc) {
            throw new Error(`DiocomReactor: v2 CRC mismatch (expected ${h.crc.toString(16)}, got ${actual.toString(16)})`);
        }
        return out;
    }

    /**
     * Encodes a v2 blob for the given recipe. Intended for tests and tools: the production encoder is the
     * Rust reactor, and the TS fallback compress() emits legacy formats only.
     * For dictionary recipes pass the dictionary bytes (recipe.dict, if set, must equal their SHA-256).
     */
    public static encodeV2(data: Buffer, recipe: ReactorRecipe, dictionary?: Buffer): Buffer {
        const codecIdx = V2_CODECS.indexOf(recipe.codec);
        const filterIdx = V2_FILTERS.indexOf(recipe.filter);
        if (codecIdx < 0) throw new Error(`DiocomReactor: unknown codec ${recipe.codec}`);
        if (filterIdx < 0) throw new Error(`DiocomReactor: unknown filter ${recipe.filter}`);
        checkStride(recipe.filter, recipe.stride);

        let dictId: Buffer = Buffer.alloc(32);
        if (dictionary || recipe.dict) {
            if (recipe.codec !== 'zstd') throw new Error('DiocomReactor: dictionaries are zstd only');
            if (!dictionary) throw new Error('DiocomReactor: recipe references a dictionary but none was supplied');
            dictId = crypto.createHash('sha256').update(dictionary).digest();
            if (recipe.dict && recipe.dict.toLowerCase() !== dictId.toString('hex')) {
                throw new Error('DiocomReactor: recipe.dict does not match the supplied dictionary');
            }
        }

        const filtered = applyFilter(data, recipe.filter, recipe.stride);
        const level = recipe.level ?? undefined;
        const wl = recipe.window_log ?? undefined;
        let payload: Buffer;
        switch (recipe.codec) {
            case 'raw':
                payload = filtered;
                break;
            case 'lz4':
                payload = lz4EncodeBlock(filtered);
                break;
            case 'deflate':
                payload = zlib.deflateSync(filtered, { level: level ?? 6 });
                break;
            case 'brotli': {
                const params: Record<number, number> = {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: level ?? 5,
                    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: filtered.length,
                };
                if (wl !== undefined) params[zlib.constants.BROTLI_PARAM_LGWIN] = wl;
                payload = zlib.brotliCompressSync(filtered, { params });
                break;
            }
            case 'zstd': {
                const c = zlibAny.constants;
                const params: Record<number, number> = { [c.ZSTD_c_compressionLevel]: level ?? 3 };
                if (wl !== undefined) params[c.ZSTD_c_windowLog] = wl;
                const opts: Record<string, unknown> = { params };
                if (dictionary) opts.dictionary = dictionary;
                payload = zstdFn('zstdCompressSync')(filtered, opts);
                break;
            }
            case 'procedural':
                if (wl !== undefined) throw new Error('DiocomReactor: procedural recipes take no window_log');
                payload = proceduralEncode(filtered, level ?? 3);
                break;
        }

        const header = Buffer.alloc(V2_HEADER_SIZE);
        header[0] = this.FLAG_RECIPE;
        header[1] = this.V2_VERSION;
        header[2] = codecIdx;
        header[3] = filterIdx;
        header[4] = recipe.stride;
        header.writeBigUInt64LE(BigInt(data.length), 5);
        header.writeUInt32LE(crc32(data), 13);
        dictId.copy(header, 17);
        return Buffer.concat([header, payload!]);
    }
}

/**
 * Minimal greedy LZ4 block encoder (no size prefix), honoring the LZ4 end-of-block rules
 * (last 5 bytes are literals; last match starts >= 12 bytes before the end). Used by encodeV2.
 */
export function lz4EncodeBlock(src: Uint8Array): Buffer {
    const n = src.length;
    const out = Buffer.allocUnsafe(n + Math.ceil(n / 255) + 16);
    let o = 0;
    const MFLIMIT = 12;
    const LAST_LITERALS = 5;
    const HASH_BITS = 16;
    const table = new Int32Array(1 << HASH_BITS).fill(-1);
    const read32 = (i: number) => (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0;
    const hash = (v: number) => Math.imul(v, 2654435761) >>> (32 - HASH_BITS);

    const writeLen = (len: number) => {
        while (len >= 255) { out[o++] = 255; len -= 255; }
        out[o++] = len;
    };
    const emit = (litStart: number, litLen: number, offset: number, matchLen: number) => {
        const ml = matchLen - 4;
        out[o++] = (Math.min(litLen, 15) << 4) | (matchLen > 0 ? Math.min(ml, 15) : 0);
        if (litLen >= 15) writeLen(litLen - 15);
        for (let k = 0; k < litLen; k++) out[o++] = src[litStart + k];
        if (matchLen > 0) {
            out[o++] = offset & 0xFF;
            out[o++] = offset >>> 8;
            if (ml >= 15) writeLen(ml - 15);
        }
    };

    let anchor = 0;
    let i = 0;
    const lastMatchStart = n - MFLIMIT;
    const matchEnd = n - LAST_LITERALS;
    while (i < lastMatchStart) {
        const v = read32(i);
        const h = hash(v);
        const cand = table[h];
        table[h] = i;
        if (cand >= 0 && i - cand <= 0xFFFF && read32(cand) === v) {
            let len = 4;
            while (i + len < matchEnd && src[cand + len] === src[i + len]) len++;
            emit(anchor, i - anchor, i - cand, len);
            i += len;
            anchor = i;
        } else {
            i++;
        }
    }
    emit(anchor, n - anchor, 0, 0);
    return out.subarray(0, o);
}

/** Pure-TS LZ4 block decoder. Throws on any malformed or size-mismatched input. */
export function lz4DecodeBlock(src: Buffer, outputSize: number): Buffer {
    const dst = Buffer.allocUnsafe(outputSize);
    const end = src.length;
    let s = 0;
    let d = 0;

    const readLen = (base: number): number => {
        let len = base;
        if (base === 15) {
            let b: number;
            do {
                if (s >= end) throw new Error('DiocomReactor: LZ4 truncated length');
                b = src[s++];
                len += b;
            } while (b === 255);
        }
        return len;
    };

    if (end === 0) throw new Error('DiocomReactor: LZ4 empty block');

    while (s < end) {
        const token = src[s++];

        const litLen = readLen(token >>> 4);
        if (s + litLen > end) throw new Error('DiocomReactor: LZ4 literals overrun input');
        if (d + litLen > outputSize) throw new Error('DiocomReactor: LZ4 literals overrun output');
        src.copy(dst, d, s, s + litLen);
        s += litLen;
        d += litLen;

        if (s === end) break; // last sequence has literals only

        if (s + 2 > end) throw new Error('DiocomReactor: LZ4 truncated match offset');
        const offset = src[s] | (src[s + 1] << 8);
        s += 2;
        if (offset === 0 || offset > d) throw new Error('DiocomReactor: LZ4 invalid match offset');

        const matchLen = readLen(token & 0x0F) + 4;
        if (d + matchLen > outputSize) throw new Error('DiocomReactor: LZ4 match overruns output');

        let m = d - offset;
        if (offset >= matchLen) {
            dst.copyWithin(d, m, m + matchLen);
            d += matchLen;
        } else {
            for (let i = 0; i < matchLen; i++) dst[d++] = dst[m++];
        }
    }

    if (d !== outputSize) throw new Error(`DiocomReactor: LZ4 size mismatch (declared ${outputSize}, got ${d})`);
    return dst;
}

// ---------------------------------------------------------------------------
// Procedural codec (blob v2 codec 5, core-reactor/docs/NETWORK_SPEC.md §1)
// ---------------------------------------------------------------------------
//
// Payload: varint program_len | program | literal_stream (one zstd frame, empty when no literals).
// Ops: 0x01 LITERAL n | 0x02 FILL n v | 0x03 REPEAT p n | 0x04 ARITH w endian k start(w, LE) delta(w, LE).
// Same accept/reject rules as core-reactor/src/procedural.rs: the whole program is validated before any
// output is allocated, and the literal stream must be exactly one zstd frame of exactly the literal bytes.

export const PROC_OP_LITERAL = 0x01;
export const PROC_OP_FILL = 0x02;
export const PROC_OP_REPEAT = 0x03;
export const PROC_OP_ARITH = 0x04;
const PROC_MAX_REPEAT_PERIOD = 16 * 1024 * 1024;
const TWO32 = 4294967296;

function procErr(msg: string): Error {
    return new Error(`DiocomReactor: procedural: ${msg}`);
}

/** Reads a LEB128 u64 (at most 10 bytes). Values above 2^53 lose precision but stay above any valid length. */
function readVarint(buf: Uint8Array, pos: { p: number }): number {
    let v = 0;
    let mul = 1;
    for (let i = 0; i < 10; i++) {
        if (pos.p >= buf.length) throw procErr('truncated varint');
        const b = buf[pos.p++];
        if (i === 9 && b > 1) throw procErr('varint overflows u64');
        v += (b & 0x7f) * mul;
        mul *= 128;
        if ((b & 0x80) === 0) return v;
    }
    throw procErr('varint overflows u64');
}

/** Appends a LEB128 varint (v must be a non-negative safe integer). */
export function writeVarint(out: number[], v: number): void {
    while (v >= 128) {
        out.push((v % 128) | 0x80);
        v = Math.floor(v / 128);
    }
    out.push(v);
}

type ProcOp =
    | { op: 1; n: number }
    | { op: 2; n: number; v: number }
    | { op: 3; p: number; n: number }
    | { op: 4; w: number; be: boolean; k: number; lo: number; hi: number; dlo: number; dhi: number };

/** Walks the program, validating every op against `limit`; calls `visit` per op. Returns totals. */
function walkProgram(prog: Uint8Array, limit: number, visit?: (op: ProcOp) => void): { out: number; literals: number } {
    const pos = { p: 0 };
    let out = 0;
    let literals = 0;
    const advance = (len: number, what: string) => {
        if (len > limit - out) throw procErr(`${what} op exceeds the original length`);
        out += len;
    };
    const take = (len: number): Uint8Array => {
        if (pos.p + len > prog.length) throw procErr('truncated op');
        const s = prog.subarray(pos.p, pos.p + len);
        pos.p += len;
        return s;
    };
    const le = (s: Uint8Array, from: number, to: number) => {
        let v = 0;
        for (let i = Math.min(to, s.length) - 1; i >= from; i--) v = v * 256 + s[i];
        return v;
    };
    while (pos.p < prog.length) {
        const code = prog[pos.p++];
        switch (code) {
            case PROC_OP_LITERAL: {
                const n = readVarint(prog, pos);
                advance(n, 'LITERAL');
                literals += n;
                visit?.({ op: 1, n });
                break;
            }
            case PROC_OP_FILL: {
                const n = readVarint(prog, pos);
                const v = take(1)[0];
                advance(n, 'FILL');
                visit?.({ op: 2, n, v });
                break;
            }
            case PROC_OP_REPEAT: {
                const p = readVarint(prog, pos);
                const n = readVarint(prog, pos);
                if (p === 0 || p > out || p > PROC_MAX_REPEAT_PERIOD) throw procErr(`invalid REPEAT period ${p} at output position ${out}`);
                advance(n, 'REPEAT');
                visit?.({ op: 3, p, n });
                break;
            }
            case PROC_OP_ARITH: {
                const we = take(2);
                const w = we[0];
                const endian = we[1];
                if (w !== 1 && w !== 2 && w !== 4 && w !== 8) throw procErr(`invalid ARITH width ${w}`);
                if (endian > 1) throw procErr(`invalid ARITH endian ${endian}`);
                const k = readVarint(prog, pos);
                if (k * w >= 18446744073709551616) throw procErr('ARITH length overflows');
                const start = take(w);
                const delta = take(w);
                advance(k * w, 'ARITH');
                visit?.({ op: 4, w, be: endian === 1, k, lo: le(start, 0, 4), hi: le(start, 4, 8), dlo: le(delta, 0, 4), dhi: le(delta, 4, 8) });
                break;
            }
            default:
                throw procErr(`unknown op 0x${code.toString(16).padStart(2, '0')}`);
        }
    }
    return { out, literals };
}

/** Byte length of the zstd frame at the start of `b` (standard frames only); throws if malformed/truncated. */
function zstdFrameLength(b: Uint8Array): number {
    const fail = (m: string) => procErr(`literal stream is not a zstd frame (${m})`);
    if (b.length < 6) throw fail('truncated');
    if (b[0] !== 0x28 || b[1] !== 0xb5 || b[2] !== 0x2f || b[3] !== 0xfd) throw fail('bad magic');
    const fhd = b[4];
    if (fhd & 0x08) throw fail('reserved bit');
    const fcsFlag = fhd >> 6;
    const single = (fhd >> 5) & 1;
    let p = 5 + (single ? 0 : 1) + [0, 1, 2, 4][fhd & 3] + (fcsFlag === 0 ? single : [0, 2, 4, 8][fcsFlag]);
    for (;;) {
        if (p + 3 > b.length) throw fail('truncated block header');
        const bh = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
        p += 3;
        const type = (bh >> 1) & 3;
        if (type === 3) throw fail('reserved block type');
        p += type === 1 ? 1 : bh >>> 3;
        if (p > b.length) throw fail('truncated block');
        if (bh & 1) break;
    }
    if (fhd & 0x04) p += 4;
    if (p > b.length) throw fail('truncated checksum');
    return p;
}

function decodeLiterals(stream: Buffer, expected: number): Buffer {
    if (expected === 0) {
        if (stream.length !== 0) throw procErr(`literal stream has ${stream.length} unused bytes`);
        return Buffer.alloc(0);
    }
    if (stream.length === 0) throw procErr('LITERAL beyond the literal stream (stream empty)');
    const frameLen = zstdFrameLength(stream);
    if (frameLen !== stream.length) throw procErr(`${stream.length - frameLen} trailing bytes after the literal stream`);
    let out: Buffer;
    try {
        out = consumedExactly(zstdFn('zstdDecompressSync')(stream, { maxOutputLength: expected, info: true }), stream.length);
    } catch (e: any) {
        if (isZlibSizeError(e)) throw procErr('literal stream has unused trailing bytes');
        throw procErr(`literal stream decode failed: ${e?.message ?? e}`);
    }
    if (out.length < expected) throw procErr(`LITERAL beyond the literal stream (${out.length} of ${expected} bytes)`);
    return out;
}

/** Decodes a procedural payload into exactly `originalLength` (filtered) bytes. Throws on any rule violation. */
export function proceduralDecode(payload: Buffer, originalLength: number): Buffer {
    const pos = { p: 0 };
    const progLen = readVarint(payload, pos);
    if (progLen > payload.length - pos.p) throw procErr(`program length ${progLen} beyond payload`);
    const prog = payload.subarray(pos.p, pos.p + progLen);
    const stream = payload.subarray(pos.p + progLen);

    // Pass 1: validate everything before allocating.
    const totals = walkProgram(prog, originalLength);
    if (totals.out !== originalLength) throw procErr(`program produces ${totals.out} bytes, original length is ${originalLength}`);
    const lits = decodeLiterals(stream, totals.literals);

    // Pass 2: execute.
    const out = Buffer.allocUnsafe(originalLength);
    let o = 0;
    let lp = 0;
    walkProgram(prog, originalLength, (op) => {
        switch (op.op) {
            case 1:
                lits.copy(out, o, lp, lp + op.n);
                o += op.n;
                lp += op.n;
                break;
            case 2:
                out.fill(op.v, o, o + op.n);
                o += op.n;
                break;
            case 3: {
                // output[pos] = output[pos - p]; the region from src is p-periodic, so copies can double
                const src = o - op.p;
                let left = op.n;
                while (left > 0) {
                    const c = Math.min(left, o - src);
                    out.copyWithin(o, src, src + c);
                    o += c;
                    left -= c;
                }
                break;
            }
            case 4: {
                const { w, be, k } = op;
                let { lo, hi } = op;
                const { dlo, dhi } = op;
                if (w === 8) {
                    for (let i = 0; i < k; i++) {
                        if (be) { out.writeUInt32BE(hi, o); out.writeUInt32BE(lo, o + 4); } else { out.writeUInt32LE(lo, o); out.writeUInt32LE(hi, o + 4); }
                        o += 8;
                        const s = lo + dlo;
                        lo = s >>> 0;
                        hi = (hi + dhi + (s >= TWO32 ? 1 : 0)) >>> 0;
                    }
                } else if (w === 4) {
                    for (let i = 0; i < k; i++) {
                        if (be) out.writeUInt32BE(lo, o); else out.writeUInt32LE(lo, o);
                        o += 4;
                        lo = (lo + dlo) >>> 0;
                    }
                } else if (w === 2) {
                    for (let i = 0; i < k; i++) {
                        if (be) { out[o] = lo >>> 8; out[o + 1] = lo & 0xff; } else { out[o] = lo & 0xff; out[o + 1] = lo >>> 8; }
                        o += 2;
                        lo = (lo + dlo) & 0xffff;
                    }
                } else {
                    for (let i = 0; i < k; i++) {
                        out[o++] = lo;
                        lo = (lo + dlo) & 0xff;
                    }
                }
                break;
            }
        }
    });
    return out;
}

/**
 * Simple greedy procedural encoder (tests/tools; the production encoder is the Rust reactor): FILL >= 32 bytes,
 * ARITH >= 16 elements (w 1/2/4/8, both endians), REPEAT with period <= 64 KiB copying >= 3 periods and >= 64 bytes;
 * longest wins (ties FILL > ARITH > REPEAT); everything else is merged into LITERALs compressed as one zstd frame.
 */
export function proceduralEncode(x: Uint8Array, level = 3): Buffer {
    const n = x.length;
    const prog: number[] = [];
    const lits: Uint8Array[] = [];
    const last = new Map<number, number>(); // 4-byte key -> last position
    let lastPeriod = 0;
    let litStart = 0;
    let i = 0;
    const elem = (p: number, w: number, be: boolean): bigint => {
        let v = 0n;
        for (let t = 0; t < w; t++) v = (v << 8n) | BigInt(x[be ? p + t : p + w - 1 - t]);
        return v;
    };
    const flush = (to: number) => {
        if (to > litStart) {
            prog.push(PROC_OP_LITERAL);
            writeVarint(prog, to - litStart);
            lits.push(x.subarray(litStart, to));
        }
    };
    const key = (p: number) => ((x[p] << 24) | (x[p + 1] << 16) | (x[p + 2] << 8) | x[p + 3]) >>> 0;
    while (i < n) {
        let bestLen = 0;
        let emit: (() => void) | null = null;
        // FILL
        let run = 1;
        while (i + run < n && x[i + run] === x[i]) run++;
        if (run >= 32) {
            const v = x[i];
            const len = run;
            bestLen = len;
            emit = () => { prog.push(PROC_OP_FILL); writeVarint(prog, len); prog.push(v); };
        } else {
            // ARITH (low-byte second difference prefilter, then exact BigInt check)
            for (const [w, be] of [[1, false], [2, false], [2, true], [4, false], [4, true], [8, false], [8, true]] as Array<[number, boolean]>) {
                if (i + 16 * w > n) continue;
                const o = be ? i + w - 1 : i;
                if (((x[o + 2 * w] - x[o + w]) & 0xff) !== ((x[o + w] - x[o]) & 0xff)) continue;
                const m = (1n << BigInt(8 * w)) - 1n;
                const e0 = elem(i, w, be);
                let prev = elem(i + w, w, be);
                const d = (prev - e0) & m;
                let k = 2;
                while (i + (k + 1) * w <= n) {
                    const e = elem(i + k * w, w, be);
                    if (((e - prev) & m) !== d) break;
                    prev = e;
                    k++;
                }
                if (k >= 16 && k * w > bestLen) {
                    const kk = k;
                    bestLen = k * w;
                    emit = () => {
                        prog.push(PROC_OP_ARITH, w, be ? 1 : 0);
                        writeVarint(prog, kk);
                        for (let t = 0; t < w; t++) prog.push(Number((e0 >> BigInt(8 * t)) & 0xffn));
                        for (let t = 0; t < w; t++) prog.push(Number((d >> BigInt(8 * t)) & 0xffn));
                    };
                }
            }
        }
        // REPEAT
        if (i + 4 <= n) {
            const kv = key(i);
            const cands = [lastPeriod];
            const c = last.get(kv);
            if (c !== undefined) cands.push(i - c);
            last.set(kv, i);
            for (const p of cands) {
                if (p < 1 || p > i || p > 65536) continue;
                let m = 0;
                while (i + m < n && x[i + m] === x[i + m - p]) m++;
                if (m >= Math.max(64, 3 * p) && m > bestLen) {
                    bestLen = m;
                    const len = m;
                    emit = () => { prog.push(PROC_OP_REPEAT); writeVarint(prog, p); writeVarint(prog, len); lastPeriod = p; };
                }
            }
        }
        if (emit) {
            flush(i);
            emit();
            i += bestLen;
            litStart = i;
        } else {
            i++;
        }
    }
    flush(n);
    const head: number[] = [];
    writeVarint(head, prog.length);
    const litBytes = Buffer.concat(lits);
    const stream = litBytes.length
        ? zstdFn('zstdCompressSync')(litBytes, { params: { [zlibAny.constants.ZSTD_c_compressionLevel]: level } })
        : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(head), Buffer.from(prog), stream]);
}
