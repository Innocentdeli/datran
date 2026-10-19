import {
    createHeader,
    deriveFileKey,
    encryptChunk,
    chunkCount,
    plainChunkLength,
    ciphertextLength,
    DCE2_HEADER_LENGTH,
    DCE2_TAG_LENGTH,
    DCE2_DEFAULT_CHUNK_SIZE,
    DCE2_SALT_LENGTH,
    DCE2_NONCE_PREFIX_LENGTH,
    Dce2FormatError,
    type Dce2Header,
    type SliceableSource,
} from '../crypto/dce2';

/**
 * Random-access DCE2 ciphertext over a plaintext File/Blob, for resumable (tus) uploads. Pure (browser + Node).
 *
 * DCE2 is deterministic given (link key, header salt, nonce prefix, chunk size, plaintext): chunk i always encrypts
 * to the same bytes at the fixed offset HEADER + i * (C + 16). So any ciphertext byte range can be regenerated on
 * demand, and a resumed upload (after a network drop or a page reload) re-creates exactly the bytes the server is
 * missing, as long as the same header parameters are reused. Those parameters are not secret (they are in the
 * ciphertext header) and may be persisted next to the tus upload URL; the link key must come from elsewhere.
 */

export interface Dce2Params {
    chunkSize: number;
    salt: Uint8Array;
    noncePrefix: Uint8Array;
}

/** JSON form of Dce2Params (base64url), for localStorage. */
export interface Dce2ParamsJson {
    chunkSize: number;
    salt: string;
    noncePrefix: string;
}

function b64u(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s: string): Uint8Array {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

export function newDce2Params(chunkSize = DCE2_DEFAULT_CHUNK_SIZE): Dce2Params {
    return {
        chunkSize,
        salt: globalThis.crypto.getRandomValues(new Uint8Array(DCE2_SALT_LENGTH)),
        noncePrefix: globalThis.crypto.getRandomValues(new Uint8Array(DCE2_NONCE_PREFIX_LENGTH)),
    };
}

export function paramsToJson(p: Dce2Params): Dce2ParamsJson {
    return { chunkSize: p.chunkSize, salt: b64u(p.salt), noncePrefix: b64u(p.noncePrefix) };
}

export function paramsFromJson(j: Dce2ParamsJson): Dce2Params {
    const p = { chunkSize: j.chunkSize, salt: unb64u(j.salt), noncePrefix: unb64u(j.noncePrefix) };
    if (p.salt.length !== DCE2_SALT_LENGTH || p.noncePrefix.length !== DCE2_NONCE_PREFIX_LENGTH) throw new Dce2FormatError('Invalid stored DCE2 parameters');
    return p;
}

export interface Dce2Source {
    readonly header: Dce2Header;
    /** Total ciphertext length (= tus Upload-Length). */
    readonly size: number;
    /** Ciphertext bytes [start, end). */
    read(start: number, end: number): Promise<Uint8Array>;
}

export async function openDce2Source(master: CryptoKey, file: SliceableSource, params: Dce2Params): Promise<Dce2Source> {
    const header = createHeader({ plaintextLength: file.size, chunkSize: params.chunkSize, salt: params.salt, noncePrefix: params.noncePrefix });
    const fileKey = await deriveFileKey(master, header);
    const size = ciphertextLength(header);
    const n = chunkCount(header);
    const stride = header.chunkSize + DCE2_TAG_LENGTH;
    // Range reads rarely align with DCE2 chunks: keep the last chunks so a straddling chunk is encrypted once.
    const cache = new Map<number, Uint8Array>();
    const encrypted = async (i: number): Promise<Uint8Array> => {
        const hit = cache.get(i);
        if (hit) return hit;
        const start = i * header.chunkSize;
        const len = plainChunkLength(header, i);
        const plain = new Uint8Array(await file.slice(start, start + len).arrayBuffer());
        if (plain.length !== len) throw new Dce2FormatError('Source changed while it was being encrypted');
        const ct = await encryptChunk(fileKey, header, i, plain);
        cache.set(i, ct);
        while (cache.size > 2) cache.delete(cache.keys().next().value as number);
        return ct;
    };
    return {
        header,
        size,
        async read(start, end) {
            end = Math.min(end, size);
            if (!Number.isSafeInteger(start) || start < 0 || start > end) throw new RangeError(`Invalid ciphertext range [${start}, ${end})`);
            const out = new Uint8Array(end - start);
            if (start < DCE2_HEADER_LENGTH) {
                out.set(header.bytes.subarray(start, Math.min(end, DCE2_HEADER_LENGTH)), 0);
            }
            if (end > DCE2_HEADER_LENGTH) {
                const first = Math.floor((Math.max(start, DCE2_HEADER_LENGTH) - DCE2_HEADER_LENGTH) / stride);
                const last = Math.min(n - 1, Math.floor((end - 1 - DCE2_HEADER_LENGTH) / stride));
                for (let i = first; i <= last; i++) {
                    const ct = await encrypted(i);
                    const chunkStart = DCE2_HEADER_LENGTH + i * stride;
                    const s = Math.max(start, chunkStart);
                    const e = Math.min(end, chunkStart + ct.length);
                    out.set(ct.subarray(s - chunkStart, e - chunkStart), s - start);
                }
            }
            return out;
        },
    };
}

/** tus-js-client `fileReader` for a Dce2Source; `wrap` turns bytes into the HTTP stack's body type (Blob / Buffer). */
export function dce2FileReader(wrap: (bytes: Uint8Array) => unknown) {
    return {
        async openFile(input: unknown) {
            const src = input as Dce2Source;
            if (!src || typeof src.read !== 'function') throw new Error('expected a DCE2 source');
            return {
                size: src.size,
                async slice(start: number, end: number) {
                    const stop = Math.min(end, src.size);
                    const bytes = await src.read(start, stop);
                    const value = wrap(bytes) as { size?: number };
                    // tus-js-client measures slices by `.size` (Blob has it; give Buffers/Uint8Arrays one).
                    if (value && typeof value === 'object' && typeof value.size !== 'number') {
                        Object.defineProperty(value, 'size', { value: bytes.length });
                    }
                    return { value, done: stop >= src.size };
                },
                close() { /* nothing to release */ },
            };
        },
    };
}
