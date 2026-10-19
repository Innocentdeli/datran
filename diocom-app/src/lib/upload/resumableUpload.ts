import type * as tus from 'tus-js-client';
import { importMasterKey, DCE2_FORMAT_FIELD, DCE2_DEFAULT_CHUNK_SIZE, type SliceableSource } from '../crypto/dce2';
import { openDce2Source, dce2FileReader, newDce2Params, paramsToJson, paramsFromJson, type Dce2ParamsJson } from './dce2Source';
import { tusUpload, forgetStoredUploads, TUS_ENDPOINT, type TusUploadOutcome } from './tusClient';

/**
 * Resumable end-to-end encrypted (DCE2) upload over tus. Pure orchestration (browser + Node); the browser wiring
 * (localStorage records, IndexedDB key vault, fallback to /api/ingest) is in ./resumableClient.ts.
 *
 * The ciphertext is generated on the fly per tus chunk (./dce2Source.ts). To resume, the exact same ciphertext
 * must be regenerated, which needs the same header parameters (salt, nonce prefix, chunk size) AND the same link
 * key. The header parameters are persisted in a resume record keyed by the file fingerprint; the link key itself is
 * never persisted in readable form: the record holds it only sealed by a `KeyVault` (in browsers an AES-GCM key
 * that is non-extractable and lives in IndexedDB, so the raw key bytes never reach storage). Without a vault (or if
 * unsealing fails) an interrupted upload can still resume within the same page (the key is in memory) but a reload
 * starts a fresh upload with a new key.
 */

export interface SealedKey {
    iv: string;
    ct: string;
}

export interface KeyVault {
    seal(keyStr: string): Promise<SealedKey | null>;
    open(sealed: SealedKey): Promise<string | null>;
}

export interface Dce2ResumeRecord {
    v: 1;
    /** Random id; part of the tus fingerprint so a record with new parameters never resumes an old upload. */
    id: string;
    params: Dce2ParamsJson;
    sealedKey: SealedKey | null;
    createdAt: number;
}

export interface ResumeRecordStore {
    get(fingerprint: string): Promise<Dce2ResumeRecord | null>;
    set(fingerprint: string, rec: Dce2ResumeRecord): Promise<void>;
    remove(fingerprint: string): Promise<void>;
}

export interface EncryptedResumableOptions {
    file: SliceableSource;
    /** Stable id of the plaintext file (name/size/mtime...). */
    fileFingerprint: string;
    /** Link key used when no resumable record exists. */
    keyStr: string;
    /** Upload-Metadata (filename, filetype, password, tags, ...); the DCE2 flags are added. */
    metadata: Record<string, string>;
    records: ResumeRecordStore;
    vault: KeyVault | null;
    /** tus-js-client body type for a ciphertext slice (Blob in browsers, Buffer in Node). */
    wrap: (bytes: Uint8Array) => unknown;
    endpoint?: string;
    /** tus PATCH size. */
    chunkSize?: number;
    dce2ChunkSize?: number;
    urlStorage?: tus.UrlStorage;
    retryDelays?: number[];
    headers?: Record<string, string>;
    onProgress?: (sent: number, total: number) => void;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
}

export interface EncryptedResumableOutcome extends TusUploadOutcome {
    /** The link key the ciphertext was made with (the recovered one when an upload resumed). */
    keyStr: string;
}

function b64u(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64u(s: string): Uint8Array<ArrayBuffer> {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/** Vault over a WebCrypto AES-GCM key (non-extractable). `getKey` returns null when unavailable. */
export function webCryptoVault(getKey: () => Promise<CryptoKey | null>): KeyVault {
    const enc = new TextEncoder();
    return {
        async seal(keyStr) {
            try {
                const key = await getKey();
                if (!key) return null;
                const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
                const ct = new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(keyStr)));
                return { iv: b64u(iv), ct: b64u(ct) };
            } catch {
                return null;
            }
        },
        async open(sealed) {
            try {
                const key = await getKey();
                if (!key) return null;
                const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(sealed.iv) }, key, unb64u(sealed.ct));
                return new TextDecoder().decode(pt);
            } catch {
                return null;
            }
        },
    };
}

export const tusFingerprintFor = (fileFingerprint: string, rec: Pick<Dce2ResumeRecord, 'id'>) => `diocom-dce2:${fileFingerprint}:${rec.id}`;

export async function uploadDce2Resumable(o: EncryptedResumableOptions): Promise<EncryptedResumableOutcome> {
    const endpoint = o.endpoint ?? TUS_ENDPOINT;
    const fp = o.fileFingerprint;
    let rec = await o.records.get(fp).catch(() => null);
    let keyStr = o.keyStr;
    if (rec) {
        const recovered = rec.sealedKey && o.vault ? await o.vault.open(rec.sealedKey) : null;
        if (recovered) {
            keyStr = recovered;
        } else {
            // The key is gone (no vault / cleared storage): the old ciphertext can't be continued. Discard it.
            await forgetStoredUploads(tusFingerprintFor(fp, rec), o.urlStorage, endpoint);
            await o.records.remove(fp).catch(() => undefined);
            rec = null;
        }
    }
    if (!rec) {
        rec = {
            v: 1,
            id: b64u(globalThis.crypto.getRandomValues(new Uint8Array(9))),
            params: paramsToJson(newDce2Params(o.dce2ChunkSize ?? DCE2_DEFAULT_CHUNK_SIZE)),
            sealedKey: o.vault ? await o.vault.seal(keyStr) : null,
            createdAt: Date.now(),
        };
        await o.records.set(fp, rec).catch(() => undefined);
    }

    const master = await importMasterKey(keyStr);
    const source = await openDce2Source(master, o.file, paramsFromJson(rec.params));
    const out = await tusUpload({
        endpoint,
        source,
        size: source.size,
        metadata: { ...o.metadata, is_encrypted: 'true', encryption_format: DCE2_FORMAT_FIELD },
        fingerprint: tusFingerprintFor(fp, rec),
        fileReader: dce2FileReader(o.wrap),
        chunkSize: o.chunkSize,
        urlStorage: o.urlStorage,
        retryDelays: o.retryDelays,
        headers: o.headers,
        onProgress: o.onProgress,
        signal: o.signal,
        fetchImpl: o.fetchImpl,
    });
    if (out.status >= 200 && out.status < 300 && out.data?.success) await o.records.remove(fp).catch(() => undefined);
    return { ...out, keyStr };
}
