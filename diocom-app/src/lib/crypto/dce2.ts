/**
 * DCE2: chunked, streaming, random-access authenticated encryption for end-to-end encrypted files.
 *
 * Construction (the STREAM construction of Hoang/Reyhanitabar/Rogaway/Vizar, as used by age and Tink's
 * AES-GCM-HKDF streaming AEAD):
 *
 *   ciphertext = header || chunk_0 || chunk_1 || ... || chunk_{n-1}
 *
 *   header (44 bytes, big endian):
 *     0  4  magic "DCE2"
 *     4  1  version (2)
 *     5  1  algorithm (1 = AES-256-GCM, key from HKDF-SHA256)
 *     6  2  reserved, must be 0
 *     8  4  chunk size C (plaintext bytes per chunk, 256 B .. 16 MiB)
 *     12 8  total plaintext length L (<= 2^53 - 1)
 *     20 16 salt (random)            -> per-file key = HKDF-SHA256(ikm = link key, salt, info = HKDF_INFO)
 *     36 7  nonce prefix (random)
 *     43 1  reserved, must be 0
 *
 *   n = max(1, ceil(L / C)); every chunk except the last holds exactly C plaintext bytes; the last holds the rest
 *   (0 bytes only when L = 0, so even an empty file carries one authenticated chunk).
 *   chunk_i = AES-256-GCM(fileKey, nonce_i, plaintext_i, aad = header) — ciphertext || 16-byte tag
 *   nonce_i = noncePrefix(7) || uint32_be(i) || (i == n-1 ? 0x01 : 0x00)
 *
 * The chunk index in the nonce prevents reordering, the last-chunk flag prevents truncation at a chunk boundary
 * and extension, and the header as AAD binds C, L, salt and nonce prefix to every chunk. Chunk i of the ciphertext
 * starts at HEADER + i * (C + 16), so any plaintext range maps to a ciphertext range.
 *
 * The raw link key (URL fragment) is only ever used as HKDF input keying material, never as an AES key.
 *
 * This module is pure (WebCrypto via globalThis.crypto, no DOM / Node APIs) so it runs in browsers, workers and
 * Node >= 20. public/e2e-core.js is a dependency-free mirror of the decrypt side for the Service Worker; the tests
 * under tests/ check that both agree.
 */

export const DCE2_MAGIC = new Uint8Array([0x44, 0x43, 0x45, 0x32]); // "DCE2"
export const DCE2_VERSION = 2;
export const DCE2_ALG_AES256GCM_HKDF_SHA256 = 1;
export const DCE2_HEADER_LENGTH = 44;
export const DCE2_TAG_LENGTH = 16;
export const DCE2_SALT_LENGTH = 16;
export const DCE2_NONCE_PREFIX_LENGTH = 7;
export const DCE2_DEFAULT_CHUNK_SIZE = 1024 * 1024; // 1 MiB
export const DCE2_MIN_CHUNK_SIZE = 256;
export const DCE2_MAX_CHUNK_SIZE = 16 * 1024 * 1024;
export const DCE2_MAX_CHUNKS = 0x1_0000_0000; // 32-bit counter
export const DCE2_HKDF_INFO = 'datran/dce2/v2/aes-256-gcm-chunk-key';
/** Stored in files.encryption_iv to mark a DCE2 upload (a v1 IV is 16 base64url chars, so it never collides). */
export const DCE2_DB_MARKER = 'DCE2';
/** Multipart field value of `encryption_format` that marks a DCE2 upload. */
export const DCE2_FORMAT_FIELD = 'dce2';

/** Malformed or unsupported header / parameters. */
export class Dce2FormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'Dce2FormatError';
    }
}

/** Authentication failed: wrong key, tampered, reordered, truncated or extended ciphertext. */
export class Dce2IntegrityError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'Dce2IntegrityError';
    }
}

export interface Dce2Header {
    version: number;
    alg: number;
    chunkSize: number;
    plaintextLength: number;
    salt: Uint8Array;
    noncePrefix: Uint8Array;
    /** The exact 44 header bytes (used as AAD). */
    bytes: Uint8Array<ArrayBuffer>;
}

/** Minimal Blob/File shape the encryptor reads from (file.slice(a, b).arrayBuffer()). */
export interface SliceableSource {
    size: number;
    slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
}

function subtle(): SubtleCrypto {
    const c = globalThis.crypto;
    if (!c?.subtle) throw new Dce2FormatError('WebCrypto (crypto.subtle) is not available in this context');
    return c.subtle;
}

const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

// ---------------------------------------------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------------------------------------------

function checkChunkSize(chunkSize: number) {
    if (!Number.isInteger(chunkSize) || chunkSize < DCE2_MIN_CHUNK_SIZE || chunkSize > DCE2_MAX_CHUNK_SIZE) {
        throw new Dce2FormatError(`Invalid DCE2 chunk size ${chunkSize}`);
    }
}

function checkLengths(plaintextLength: number, chunkSize: number) {
    if (!Number.isSafeInteger(plaintextLength) || plaintextLength < 0) {
        throw new Dce2FormatError(`Invalid DCE2 plaintext length ${plaintextLength}`);
    }
    if (chunkCount({ plaintextLength, chunkSize }) > DCE2_MAX_CHUNKS) {
        throw new Dce2FormatError('DCE2 plaintext too long for the chunk size');
    }
}

export function createHeader(opts: {
    plaintextLength: number;
    chunkSize?: number;
    salt?: Uint8Array;
    noncePrefix?: Uint8Array;
}): Dce2Header {
    const chunkSize = opts.chunkSize ?? DCE2_DEFAULT_CHUNK_SIZE;
    checkChunkSize(chunkSize);
    checkLengths(opts.plaintextLength, chunkSize);
    const salt = opts.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(DCE2_SALT_LENGTH));
    const noncePrefix = opts.noncePrefix ?? globalThis.crypto.getRandomValues(new Uint8Array(DCE2_NONCE_PREFIX_LENGTH));
    if (salt.length !== DCE2_SALT_LENGTH) throw new Dce2FormatError('DCE2 salt must be 16 bytes');
    if (noncePrefix.length !== DCE2_NONCE_PREFIX_LENGTH) throw new Dce2FormatError('DCE2 nonce prefix must be 7 bytes');

    const bytes = new Uint8Array(DCE2_HEADER_LENGTH);
    const view = new DataView(bytes.buffer);
    bytes.set(DCE2_MAGIC, 0);
    bytes[4] = DCE2_VERSION;
    bytes[5] = DCE2_ALG_AES256GCM_HKDF_SHA256;
    view.setUint32(8, chunkSize);
    view.setBigUint64(12, BigInt(opts.plaintextLength));
    bytes.set(salt, 20);
    bytes.set(noncePrefix, 36);
    return parseHeader(bytes);
}

/** True when the bytes start with the DCE2 magic (cheap format sniffing; does not validate). */
export function hasDce2Magic(bytes: Uint8Array): boolean {
    return bytes.length >= 4 && DCE2_MAGIC.every((b, i) => bytes[i] === b);
}

export function parseHeader(input: Uint8Array): Dce2Header {
    if (input.length < DCE2_HEADER_LENGTH) throw new Dce2FormatError('DCE2 header truncated');
    if (!hasDce2Magic(input)) throw new Dce2FormatError('Not a DCE2 ciphertext (bad magic)');
    const bytes = new Uint8Array(input.subarray(0, DCE2_HEADER_LENGTH)); // own copy
    const view = new DataView(bytes.buffer);
    const version = bytes[4];
    const alg = bytes[5];
    if (version !== DCE2_VERSION) throw new Dce2FormatError(`Unsupported DCE2 version ${version}`);
    if (alg !== DCE2_ALG_AES256GCM_HKDF_SHA256) throw new Dce2FormatError(`Unsupported DCE2 algorithm ${alg}`);
    if (view.getUint16(6) !== 0 || bytes[43] !== 0) throw new Dce2FormatError('DCE2 reserved header bytes must be zero');
    const chunkSize = view.getUint32(8);
    checkChunkSize(chunkSize);
    const big = view.getBigUint64(12);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Dce2FormatError('DCE2 plaintext length too large');
    const plaintextLength = Number(big);
    checkLengths(plaintextLength, chunkSize);
    return {
        version,
        alg,
        chunkSize,
        plaintextLength,
        salt: bytes.slice(20, 36),
        noncePrefix: bytes.slice(36, 43),
        bytes,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// Layout math
// ---------------------------------------------------------------------------------------------------------------

type Layout = Pick<Dce2Header, 'plaintextLength' | 'chunkSize'>;

export function chunkCount(h: Layout): number {
    return Math.max(1, Math.ceil(h.plaintextLength / h.chunkSize));
}

export function plainChunkLength(h: Layout, index: number): number {
    const n = chunkCount(h);
    if (!Number.isInteger(index) || index < 0 || index >= n) throw new Dce2FormatError(`Chunk ${index} out of range`);
    return index < n - 1 ? h.chunkSize : h.plaintextLength - (n - 1) * h.chunkSize;
}

/** Byte offset of chunk `index` in the ciphertext. */
export function cipherChunkOffset(h: Layout, index: number): number {
    return DCE2_HEADER_LENGTH + index * (h.chunkSize + DCE2_TAG_LENGTH);
}

export function ciphertextLength(h: Layout): number {
    return DCE2_HEADER_LENGTH + chunkCount(h) * DCE2_TAG_LENGTH + h.plaintextLength;
}

export interface CipherRange {
    firstChunk: number;
    lastChunk: number;
    /** First ciphertext byte to fetch (inclusive). */
    cipherStart: number;
    /** Last ciphertext byte to fetch (inclusive). */
    cipherEnd: number;
}

/**
 * Maps the plaintext byte range [start, end) to the chunks and the ciphertext byte range that cover it.
 * An empty range is only valid for an empty file (it still covers the single authenticated chunk).
 */
export function plaintextRangeToCipherRange(h: Layout, start: number, end: number): CipherRange {
    const L = h.plaintextLength;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > L || start > end) {
        throw new Dce2FormatError(`Invalid plaintext range [${start}, ${end}) for length ${L}`);
    }
    if (start === end && L !== 0) throw new Dce2FormatError('Empty plaintext range');
    const firstChunk = L === 0 ? 0 : Math.floor(start / h.chunkSize);
    const lastChunk = L === 0 ? 0 : Math.floor((end - 1) / h.chunkSize);
    return {
        firstChunk,
        lastChunk,
        cipherStart: cipherChunkOffset(h, firstChunk),
        cipherEnd: cipherChunkOffset(h, lastChunk) + plainChunkLength(h, lastChunk) + DCE2_TAG_LENGTH - 1,
    };
}

export function chunkNonce(h: Dce2Header, index: number): Uint8Array<ArrayBuffer> {
    const nonce = new Uint8Array(12);
    nonce.set(h.noncePrefix, 0);
    new DataView(nonce.buffer).setUint32(7, index);
    nonce[11] = index === chunkCount(h) - 1 ? 1 : 0;
    return nonce;
}

// ---------------------------------------------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------------------------------------------

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Imports the link key (raw bytes or base64url from the URL fragment) as non-extractable HKDF keying material.
 */
export async function importMasterKey(key: Uint8Array | string): Promise<CryptoKey> {
    const raw = typeof key === 'string' ? base64UrlDecode(key) : buf(key);
    if (raw.length < 16) throw new Dce2FormatError('DCE2 link key too short');
    return subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
}

/** Per-file AES-256-GCM key: HKDF-SHA256(link key, header salt, DCE2_HKDF_INFO). */
export async function deriveFileKey(master: CryptoKey, h: Dce2Header): Promise<CryptoKey> {
    return subtle().deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: buf(h.salt), info: new TextEncoder().encode(DCE2_HKDF_INFO) },
        master,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

// ---------------------------------------------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------------------------------------------

export async function encryptChunk(fileKey: CryptoKey, h: Dce2Header, index: number, plaintext: Uint8Array): Promise<Uint8Array> {
    if (plaintext.length !== plainChunkLength(h, index)) {
        throw new Dce2FormatError(`Chunk ${index} must hold ${plainChunkLength(h, index)} bytes, got ${plaintext.length}`);
    }
    const ct = await subtle().encrypt(
        { name: 'AES-GCM', iv: chunkNonce(h, index), additionalData: h.bytes, tagLength: 128 },
        fileKey,
        buf(plaintext),
    );
    return new Uint8Array(ct);
}

export async function decryptChunk(fileKey: CryptoKey, h: Dce2Header, index: number, ciphertext: Uint8Array): Promise<Uint8Array> {
    const expected = plainChunkLength(h, index) + DCE2_TAG_LENGTH;
    if (ciphertext.length !== expected) {
        throw new Dce2IntegrityError(`Chunk ${index} has ${ciphertext.length} bytes, expected ${expected} (truncated or corrupted)`);
    }
    try {
        const pt = await subtle().decrypt(
            { name: 'AES-GCM', iv: chunkNonce(h, index), additionalData: h.bytes, tagLength: 128 },
            fileKey,
            buf(ciphertext),
        );
        return new Uint8Array(pt);
    } catch {
        throw new Dce2IntegrityError(`Chunk ${index} failed authentication (wrong key or tampered data)`);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Encryption (streaming from a File/Blob; never holds more than one chunk of plaintext)
// ---------------------------------------------------------------------------------------------------------------

export interface EncryptOptions {
    chunkSize?: number;
    /** Called after each chunk with plaintext bytes processed so far. */
    onProgress?: (doneBytes: number, totalBytes: number) => void;
    /** Test hooks: fixed salt / nonce prefix. */
    salt?: Uint8Array;
    noncePrefix?: Uint8Array;
}

/**
 * Encrypts a File/Blob chunk by chunk: yields the header, then each encrypted chunk.
 * Total output length is ciphertextLength(header) (exposed as `header` on the first call of `next()`).
 */
export async function* encryptSourceChunks(master: CryptoKey, source: SliceableSource, opts: EncryptOptions = {}): AsyncGenerator<Uint8Array, void, void> {
    const header = createHeader({ plaintextLength: source.size, chunkSize: opts.chunkSize, salt: opts.salt, noncePrefix: opts.noncePrefix });
    const fileKey = await deriveFileKey(master, header);
    yield header.bytes;
    const n = chunkCount(header);
    for (let i = 0; i < n; i++) {
        const start = i * header.chunkSize;
        const end = start + plainChunkLength(header, i);
        const plain = new Uint8Array(await source.slice(start, end).arrayBuffer());
        if (plain.length !== end - start) throw new Dce2FormatError('Source changed while it was being encrypted');
        yield await encryptChunk(fileKey, header, i, plain);
        opts.onProgress?.(end, source.size);
    }
}

/** Expected ciphertext size for a plaintext of `plaintextLength` bytes. */
export function encryptedSize(plaintextLength: number, chunkSize = DCE2_DEFAULT_CHUNK_SIZE): number {
    return ciphertextLength({ plaintextLength, chunkSize });
}

/** In-memory convenience (tests, small payloads). */
export async function encryptBytes(master: CryptoKey, data: Uint8Array, opts: EncryptOptions = {}): Promise<Uint8Array> {
    const source: SliceableSource = {
        size: data.length,
        slice: (a, b) => ({ arrayBuffer: async () => data.slice(a, b).buffer as ArrayBuffer }),
    };
    const out = new Uint8Array(encryptedSize(data.length, opts.chunkSize));
    let off = 0;
    for await (const part of encryptSourceChunks(master, source, opts)) {
        out.set(part, off);
        off += part.length;
    }
    return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Decryption
// ---------------------------------------------------------------------------------------------------------------

/** Pulls exact byte counts out of a ReadableStream reader. */
class ExactReader {
    private pending: Uint8Array[] = [];
    private pendingLen = 0;
    private done = false;
    constructor(private reader: ReadableStreamDefaultReader<Uint8Array>) { }

    /** Returns exactly n bytes, or fewer only if the stream ended. */
    async read(n: number): Promise<Uint8Array> {
        while (this.pendingLen < n && !this.done) {
            const { value, done } = await this.reader.read();
            if (done) this.done = true;
            else if (value && value.length) {
                this.pending.push(value);
                this.pendingLen += value.length;
            }
        }
        const take = Math.min(n, this.pendingLen);
        const out = new Uint8Array(take);
        let off = 0;
        while (off < take) {
            const head = this.pending[0];
            const k = Math.min(head.length, take - off);
            out.set(head.subarray(0, k), off);
            off += k;
            if (k === head.length) this.pending.shift();
            else this.pending[0] = head.subarray(k);
        }
        this.pendingLen -= take;
        return out;
    }

    /** True if no more bytes follow. */
    async atEnd(): Promise<boolean> {
        if (this.pendingLen > 0) return false;
        if (this.done) return true;
        const extra = await this.read(1);
        if (extra.length) {
            this.pending.unshift(extra);
            this.pendingLen += extra.length;
            return false;
        }
        return true;
    }

    cancel(reason?: unknown) {
        return this.reader.cancel(reason).catch(() => { });
    }
}

export interface RangeStreamOptions {
    fileKey: CryptoKey;
    header: Dce2Header;
    /** Plaintext range [start, end). */
    start: number;
    end: number;
    /** Opens the ciphertext byte range [cipherStart, cipherEnd] (inclusive). */
    openCiphertext: (cipherStart: number, cipherEnd: number, signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
}

/**
 * Plaintext stream for [start, end): fetches only the covering chunks, verifies each one before emitting any of its
 * bytes, and errors (instead of ending) on any authentication failure or short read. Holds at most ~2 chunks.
 */
export function decryptRangeStream(o: RangeStreamOptions): ReadableStream<Uint8Array> {
    const { header: h } = o;
    const range = plaintextRangeToCipherRange(h, o.start, o.end);
    const ac = new AbortController();
    let reader: ExactReader | null = null;
    let index = range.firstChunk;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                if (!reader) reader = new ExactReader((await o.openCiphertext(range.cipherStart, range.cipherEnd, ac.signal)).getReader());
                const need = plainChunkLength(h, index) + DCE2_TAG_LENGTH;
                const ct = await reader.read(need);
                if (ct.length !== need) throw new Dce2IntegrityError(`Ciphertext ended inside chunk ${index} (truncated)`);
                const pt = await decryptChunk(o.fileKey, h, index, ct);
                const chunkStart = index * h.chunkSize;
                const s = Math.max(o.start - chunkStart, 0);
                const e = Math.min(o.end - chunkStart, pt.length);
                if (e > s) controller.enqueue(pt.subarray(s, e));
                index++;
                if (index > range.lastChunk) {
                    const extra = !(await reader.atEnd());
                    await reader.cancel();
                    if (extra) throw new Dce2IntegrityError('Unexpected bytes after the requested ciphertext range');
                    controller.close();
                }
            } catch (err) {
                ac.abort();
                await reader?.cancel(err);
                throw err;
            }
        },
        async cancel(reason) {
            ac.abort();
            await reader?.cancel(reason);
        },
    }, { highWaterMark: 1 });
}

export interface FullDecryptOptions {
    /** Known total ciphertext length (e.g. Content-Length); checked against the header to catch truncation early. */
    ciphertextLength?: number;
    onHeader?: (h: Dce2Header) => void;
    onProgress?: (doneBytes: number, totalBytes: number) => void;
}

/**
 * Decrypts a complete DCE2 ciphertext stream (header first) into a plaintext stream. Trailing data after the final
 * chunk, a missing final chunk or any tampered chunk errors the stream.
 */
export function decryptFullStream(master: CryptoKey, ciphertext: ReadableStream<Uint8Array>, opts: FullDecryptOptions = {}): ReadableStream<Uint8Array> {
    const reader = new ExactReader(ciphertext.getReader());
    let header: Dce2Header | null = null;
    let fileKey: CryptoKey | null = null;
    let index = 0;
    let done = 0;
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                if (!header || !fileKey) {
                    const hb = await reader.read(DCE2_HEADER_LENGTH);
                    header = parseHeader(hb);
                    if (opts.ciphertextLength !== undefined && opts.ciphertextLength !== ciphertextLength(header)) {
                        throw new Dce2IntegrityError(`Ciphertext is ${opts.ciphertextLength} bytes, header implies ${ciphertextLength(header)} (truncated or extended)`);
                    }
                    fileKey = await deriveFileKey(master, header);
                    opts.onHeader?.(header);
                }
                const need = plainChunkLength(header, index) + DCE2_TAG_LENGTH;
                const ct = await reader.read(need);
                if (ct.length !== need) throw new Dce2IntegrityError(`Ciphertext ended inside chunk ${index} (truncated)`);
                const pt = await decryptChunk(fileKey, header, index, ct);
                if (pt.length) controller.enqueue(pt);
                done += pt.length;
                opts.onProgress?.(done, header.plaintextLength);
                index++;
                if (index === chunkCount(header)) {
                    if (!(await reader.atEnd())) throw new Dce2IntegrityError('Unexpected data after the final chunk (extended)');
                    controller.close();
                }
            } catch (err) {
                await reader.cancel(err);
                throw err;
            }
        },
        async cancel(reason) {
            await reader.cancel(reason);
        },
    }, { highWaterMark: 1 });
}

/** In-memory convenience: decrypts a complete ciphertext (tests, small payloads, in-page fallback). */
export async function decryptBytes(master: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
    const src = new ReadableStream<Uint8Array>({
        start(c) {
            c.enqueue(data);
            c.close();
        },
    });
    return collect(decryptFullStream(master, src, { ciphertextLength: data.length }));
}

export async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    let len = 0;
    const r = stream.getReader();
    for (; ;) {
        const { value, done } = await r.read();
        if (done) break;
        parts.push(value);
        len += value.length;
    }
    const out = new Uint8Array(len);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}
