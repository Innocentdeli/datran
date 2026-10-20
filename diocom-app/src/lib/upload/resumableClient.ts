/**
 * Browser upload entry points: tus (/api/uploads) for everything, with the single-request /api/ingest upload as the
 * fallback for tiny files and for when tus is unavailable or fails for a transport reason.
 *
 *  - Progress: tus-js-client progress events.
 *  - Network drop: tus-js-client retries with backoff (DEFAULT_RETRY_DELAYS) and resumes from the server offset.
 *  - Page reload: selecting the same file again resumes it (fingerprint -> upload URL in localStorage). For E2E
 *    uploads the DCE2 header parameters are kept in localStorage and the link key only sealed by a non-extractable
 *    IndexedDB key (see ./resumableUpload.ts), so the regenerated ciphertext matches the bytes already uploaded.
 */
import * as tus from 'tus-js-client';
import { uploadEncryptedFile, xhrUpload, type EncryptedUploadOptions, type UploadResult } from '../crypto/e2eClient';
import { tusUpload, forgetStoredUploads, TusUploadError, TUS_ENDPOINT, type TusUploadOutcome } from './tusClient';
import {
    uploadDce2Resumable,
    webCryptoVault,
    tusFingerprintFor,
    type Dce2ResumeRecord,
    type ResumeRecordStore,
    type KeyVault,
} from './resumableUpload';

/** Below this size a single /api/ingest request is cheaper than tus' extra round trips. */
export const TUS_MIN_BYTES = 1024 * 1024;
const RECORD_PREFIX = 'diocom_tus_dce2:';
const VAULT_DB = 'diocom-upload-vault';
const VAULT_STORE = 'keys';
const VAULT_KEY_ID = 'resume-wrap-v1';

export interface ResumableResult extends UploadResult {
    /** Link key of the stored ciphertext (differs from the batch key when an earlier upload was resumed). */
    keyStr: string;
    /** Offset an interrupted upload was resumed from, if any. */
    resumedFrom: number | null;
}

// ---------------------------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------------------------

const localRecords: ResumeRecordStore = {
    async get(fp) {
        try {
            const raw = localStorage.getItem(RECORD_PREFIX + fp);
            return raw ? JSON.parse(raw) as Dce2ResumeRecord : null;
        } catch {
            return null;
        }
    },
    async set(fp, rec) {
        try { localStorage.setItem(RECORD_PREFIX + fp, JSON.stringify(rec)); } catch { /* storage full / disabled */ }
    },
    async remove(fp) {
        try { localStorage.removeItem(RECORD_PREFIX + fp); } catch { /* ignore */ }
    },
};

let vaultKey: Promise<CryptoKey | null> | null = null;

/** Non-extractable AES-GCM key kept in IndexedDB (structured clone of a CryptoKey; its bytes are never readable). */
function getVaultKey(): Promise<CryptoKey | null> {
    if (vaultKey) return vaultKey;
    vaultKey = new Promise<CryptoKey | null>((resolve) => {
        if (typeof indexedDB === 'undefined' || !globalThis.crypto?.subtle) { resolve(null); return; }
        const open = indexedDB.open(VAULT_DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(VAULT_STORE);
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
            const db = open.result;
            const get = db.transaction(VAULT_STORE, 'readonly').objectStore(VAULT_STORE).get(VAULT_KEY_ID);
            get.onerror = () => resolve(null);
            get.onsuccess = async () => {
                if (get.result instanceof CryptoKey) { resolve(get.result); return; }
                try {
                    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
                    const put = db.transaction(VAULT_STORE, 'readwrite').objectStore(VAULT_STORE).put(key, VAULT_KEY_ID);
                    put.onsuccess = () => resolve(key);
                    put.onerror = () => resolve(null);
                } catch {
                    resolve(null);
                }
            };
        };
    });
    return vaultKey;
}

const vault: KeyVault = webCryptoVault(getVaultKey);

function fileFingerprint(file: File): string {
    return [file.name, file.type, file.size, file.lastModified].join('|');
}

/** Errors that a plain /api/ingest retry would hit as well (validation, auth, limits): no fallback. */
function isDefinitive(status: number | null): boolean {
    return status !== null && [400, 401, 403, 413, 415, 429].includes(status);
}

/** What an aborted upload rejects with (Cancel / Pause in the UI). The tus upload and its resume state are kept. */
function abortError(): DOMException {
    return new DOMException('Upload aborted', 'AbortError');
}

export function isAbortError(e: unknown): boolean {
    return e instanceof DOMException && e.name === 'AbortError';
}

function parseBody(body: string | null): UploadResult['data'] {
    try { return body ? JSON.parse(body) : null; } catch { return null; }
}

function toResult(out: TusUploadOutcome, keyStr: string): ResumableResult {
    return { status: out.status, data: out.data, transport: 'tus', keyStr, resumedFrom: out.resumedFrom };
}

// ---------------------------------------------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------------------------------------------

/**
 * E2E-encrypted (DCE2) upload: tus with on-the-fly encryption and resume; /api/ingest for tiny files or when tus
 * fails for a transport reason.
 */
export async function uploadEncryptedResumable(o: EncryptedUploadOptions): Promise<ResumableResult> {
    const fallback = async (): Promise<ResumableResult> => ({ ...(await uploadEncryptedFile(o)), keyStr: o.keyStr, resumedFrom: null });
    if (o.file.size < TUS_MIN_BYTES || !tus.isSupported) return fallback();

    const fp = fileFingerprint(o.file);
    const metadata: Record<string, string> = Object.fromEntries(o.fields);
    metadata.filename = o.file.name;
    metadata.filetype = 'application/octet-stream'; // ciphertext; the viewer derives the type from the name
    try {
        const out = await uploadDce2Resumable({
            file: o.file,
            fileFingerprint: fp,
            keyStr: o.keyStr,
            metadata,
            records: localRecords,
            vault,
            wrap: (bytes) => new Blob([bytes as Uint8Array<ArrayBuffer>]),
            endpoint: TUS_ENDPOINT,
            dce2ChunkSize: o.chunkSize,
            onProgress: (sent, total) => o.onProgress?.(total ? sent / total : 1, 'uploading'),
            signal: o.signal,
        });
        return toResult(out, out.keyStr);
    } catch (e) {
        // Paused/cancelled: never fall back to a single request (that would restart the upload from zero).
        if (o.signal?.aborted) throw abortError();
        const status = e instanceof TusUploadError ? e.status : null;
        if (e instanceof TusUploadError && isDefinitive(status)) {
            return { status: status!, data: parseBody(e.body), transport: 'tus', keyStr: o.keyStr, resumedFrom: null };
        }
        console.warn('[upload] Resumable upload failed, falling back to a single request:', e);
        const result = await fallback();
        if (result.status >= 200 && result.status < 300) {
            // Stored by the fallback: drop the unfinished tus upload and its resume record.
            const rec = await localRecords.get(fp);
            if (rec) await forgetStoredUploads(tusFingerprintFor(fp, rec));
            await localRecords.remove(fp);
        }
        return result;
    }
}

export interface PlainUploadOptions {
    file: File;
    fields: Array<[string, string]>;
    onProgress?: (fraction: number) => void;
    /** Aborts the upload (rejects with an AbortError DOMException); a tus upload stays resumable. */
    signal?: AbortSignal;
}

async function xhrIngest(file: File, fields: Array<[string, string]>, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<UploadResult> {
    const form = new FormData();
    for (const [k, v] of fields) form.append(k, v);
    form.append('file', file, file.name);
    const res = await xhrUpload('/api/ingest', form, onProgress, signal);
    return { status: res.status, data: res.data as UploadResult['data'], transport: 'blob' };
}

/** Unencrypted upload: tus directly (resumable), /api/ingest for tiny files or as the fallback. */
export async function uploadPlainResumable(o: PlainUploadOptions): Promise<UploadResult & { resumedFrom: number | null }> {
    const fallback = async () => ({ ...(await xhrIngest(o.file, o.fields, o.onProgress, o.signal)), resumedFrom: null });
    if (o.file.size < TUS_MIN_BYTES || !tus.isSupported) return fallback();
    const metadata: Record<string, string> = Object.fromEntries(o.fields);
    metadata.filename = o.file.name;
    metadata.filetype = o.file.type || 'application/octet-stream';
    try {
        const out = await tusUpload({
            endpoint: TUS_ENDPOINT,
            source: o.file,
            size: o.file.size,
            metadata,
            fingerprint: `diocom-plain:${fileFingerprint(o.file)}`,
            onProgress: (sent, total) => o.onProgress?.(total ? sent / total : 1),
            signal: o.signal,
        });
        return { status: out.status, data: out.data, transport: 'tus', resumedFrom: out.resumedFrom };
    } catch (e) {
        if (o.signal?.aborted) throw abortError();
        const status = e instanceof TusUploadError ? e.status : null;
        if (e instanceof TusUploadError && isDefinitive(status)) return { status: status!, data: parseBody(e.body), transport: 'tus', resumedFrom: null };
        console.warn('[upload] Resumable upload failed, falling back to a single request:', e);
        return fallback();
    }
}

/**
 * Forgets an interrupted upload of `file` (Cancel): terminates the unfinished tus upload on the server and drops the
 * local resume state (DCE2 record and stored upload URLs), so selecting the file again starts from scratch.
 */
export async function discardResumableUpload(file: File): Promise<void> {
    const fp = fileFingerprint(file);
    const rec = await localRecords.get(fp);
    if (rec) await forgetStoredUploads(tusFingerprintFor(fp, rec));
    await localRecords.remove(fp);
    await forgetStoredUploads(`diocom-plain:${fp}`);
}
