/**
 * Browser side of end-to-end encryption: key lookup, the decrypting Service Worker (public/e2e-sw.js), streaming
 * DCE2 uploads, and in-page fallbacks. Pure format logic lives in ./dce2.
 */
import * as Encryption from './Encryption';
import {
    DCE2_DB_MARKER,
    DCE2_FORMAT_FIELD,
    encryptSourceChunks,
    encryptedSize,
    importMasterKey,
    decryptFullStream,
} from './dce2';
import { getMimeType } from '../fileUtils';
import type { PublicFile } from '../../db/files';

export const E2E_SW_URL = '/e2e-sw.js';
/** The worker only controls /v1/ pages (the viewer) and only answers /v1/e2e/... requests. */
export const E2E_SW_SCOPE = '/v1/';
export const E2E_VIRTUAL_PREFIX = '/v1/e2e/';
/** Largest DCE2 ciphertext decrypted into page memory when no Service Worker is available. */
export const IN_PAGE_DECRYPT_CAP = 256 * 1024 * 1024;

export type EncryptionFormat = 'dce2' | 'v1' | null;

type FileMeta = Pick<PublicFile, 'is_encrypted' | 'encryption_iv' | 'original_name' | 'file_size'> & { encryption_format?: EncryptionFormat };

export function encryptionFormatOf(meta?: Partial<FileMeta> | null): EncryptionFormat {
    if (!meta || meta.is_encrypted !== 1) return null;
    if (meta.encryption_format !== undefined) return meta.encryption_format;
    if (meta.encryption_iv === DCE2_DB_MARKER) return 'dce2';
    return meta.encryption_iv ? 'v1' : null;
}

export function displayName(fileId: string, meta?: Partial<FileMeta> | null): string {
    return meta?.original_name || decodeURIComponent(fileId).replace(/\.(omni|reactor)\.acs$/, '');
}

export function streamUrl(fileId: string): string {
    return `/api/stream?file=${encodeURIComponent(fileId)}`;
}

/** Link key from the URL fragment (#key=...), falling back to the copy kept in localStorage. */
export function getShareKey(fileId: string): string | null {
    if (typeof window === 'undefined') return null;
    const hashKey = window.location.hash.match(/key=([^&]+)/)?.[1];
    if (hashKey) {
        try {
            localStorage.setItem(`diocom_key_${fileId}`, hashKey);
        } catch { /* storage unavailable */ }
        return hashKey;
    }
    try {
        return localStorage.getItem(`diocom_key_${fileId}`);
    } catch {
        return null;
    }
}

export class E2EError extends Error {
    constructor(message: string, public readonly code: 'NO_KEY' | 'TOO_LARGE' | 'INTEGRITY' | 'HTTP' | 'UNSUPPORTED') {
        super(message);
        this.name = 'E2EError';
    }
}

function integrityMessage(err: unknown): E2EError {
    const name = err instanceof Error ? err.name : '';
    if (name === 'Dce2IntegrityError' || name === 'OperationError' || name === 'Dce2FormatError') {
        return new E2EError('Decryption failed: the key is wrong or the encrypted data was tampered with or truncated. No partial file was produced.', 'INTEGRITY');
    }
    return err instanceof E2EError ? err : new E2EError(err instanceof Error ? err.message : String(err), 'HTTP');
}

function formatMB(bytes: number) {
    return `${Math.round(bytes / (1024 * 1024))} MB`;
}

// ---------------------------------------------------------------------------------------------------------------
// Service Worker
// ---------------------------------------------------------------------------------------------------------------

interface PageKey { key: string; name: string; mime: string }
const pageKeys = new Map<string, PageKey>();
const errorListeners = new Map<string, Set<(message: string) => void>>();
let listenerInstalled = false;
let workerPromise: Promise<ServiceWorker | null> | null = null;

function installMessageListener() {
    if (listenerInstalled) return;
    listenerInstalled = true;
    navigator.serviceWorker.addEventListener('message', (ev: MessageEvent) => {
        const data = ev.data || {};
        if (data.type === 'e2e-key-request' && typeof data.shareId === 'string') {
            // The worker restarted and lost its in-memory keys: hand it the key again (never leaves the browser).
            const k = pageKeys.get(data.shareId);
            ev.ports[0]?.postMessage(k ? { key: k.key, name: k.name, mime: k.mime } : { key: null });
        } else if (data.type === 'e2e-error' && typeof data.shareId === 'string') {
            const message = data.name === 'Dce2IntegrityError' || data.name === 'Dce2FormatError'
                ? 'Decryption failed: the encrypted data was tampered with or truncated (or the key is wrong). Playback/download was stopped.'
                : `Decryption error: ${data.message}`;
            errorListeners.get(data.shareId)?.forEach((cb) => cb(message));
        }
    });
}

/** Subscribes to decryption errors the worker reports for a share (mid-stream integrity failures). */
export function subscribeE2EErrors(shareId: string, cb: (message: string) => void): () => void {
    let set = errorListeners.get(shareId);
    if (!set) errorListeners.set(shareId, (set = new Set()));
    set.add(cb);
    return () => set!.delete(cb);
}

function postWithAck<T = { ok?: boolean }>(target: ServiceWorker, msg: unknown, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
        const ch = new MessageChannel();
        const timer = setTimeout(() => reject(new Error('Service Worker did not answer')), timeoutMs);
        ch.port1.onmessage = (ev) => {
            clearTimeout(timer);
            resolve(ev.data as T);
        };
        target.postMessage(msg, [ch.port2]);
    });
}

function waitFor<T>(check: () => T | null | undefined, subscribe: (fire: () => void) => () => void, timeoutMs: number): Promise<T | null> {
    const now = check();
    if (now) return Promise.resolve(now);
    return new Promise((resolve) => {
        const done = (v: T | null) => {
            clearTimeout(timer);
            unsub();
            resolve(v);
        };
        const timer = setTimeout(() => done(check() ?? null), timeoutMs);
        const unsub = subscribe(() => {
            const v = check();
            if (v) done(v);
        });
    });
}

/** Registers the decrypting worker and resolves to the controller of this page, or null if unavailable. */
export function ensureE2EWorker(): Promise<ServiceWorker | null> {
    if (workerPromise) return workerPromise;
    workerPromise = (async () => {
        if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !window.isSecureContext) return null;
        if (!window.location.pathname.startsWith(E2E_SW_SCOPE)) return null;
        try {
            installMessageListener();
            const reg = await navigator.serviceWorker.register(E2E_SW_URL, { scope: E2E_SW_SCOPE, updateViaCache: 'none' });
            const active = await waitFor(
                () => reg.active,
                (fire) => {
                    const sw = reg.installing || reg.waiting;
                    sw?.addEventListener('statechange', fire);
                    reg.addEventListener('updatefound', fire);
                    return () => {
                        sw?.removeEventListener('statechange', fire);
                        reg.removeEventListener('updatefound', fire);
                    };
                },
                10_000,
            );
            if (!active) return null;
            if (!navigator.serviceWorker.controller) {
                // First visit (or a hard reload): ask the active worker to take control of this page.
                await postWithAck(active, { type: 'e2e-claim' }, 3000).catch(() => undefined);
            }
            const controller = await waitFor(
                () => navigator.serviceWorker.controller,
                (fire) => {
                    navigator.serviceWorker.addEventListener('controllerchange', fire);
                    return () => navigator.serviceWorker.removeEventListener('controllerchange', fire);
                },
                3000,
            );
            if (!controller) return null;
            const pong = await postWithAck<{ ok?: boolean }>(controller, { type: 'e2e-ping' }, 3000);
            return pong?.ok ? controller : null;
        } catch (err) {
            console.warn('[E2E] Streaming decryptor unavailable, using in-page fallback:', err);
            return null;
        }
    })();
    return workerPromise;
}

async function registerKeyWithWorker(worker: ServiceWorker, shareId: string, entry: PageKey): Promise<boolean> {
    pageKeys.set(shareId, entry);
    const current = navigator.serviceWorker.controller || worker;
    try {
        const ack = await postWithAck<{ ok?: boolean }>(current, { type: 'e2e-register', shareId, ...entry }, 5000);
        return !!ack?.ok;
    } catch {
        return false;
    }
}

/** Virtual URL the worker serves decrypted (supports Range). */
export function e2eUrl(shareId: string, name: string, download = false): string {
    return `${E2E_VIRTUAL_PREFIX}${encodeURIComponent(shareId)}/${encodeURIComponent(name || 'download')}${download ? '?dl=1' : ''}`;
}

/** Ensures the worker holds the key for this share; returns false when streaming decryption is unavailable. */
async function prepareWorker(fileId: string, keyStr: string, name: string): Promise<boolean> {
    const worker = await ensureE2EWorker();
    if (!worker) return false;
    return registerKeyWithWorker(worker, fileId, { key: keyStr, name, mime: getMimeType(name) });
}

// ---------------------------------------------------------------------------------------------------------------
// Viewing
// ---------------------------------------------------------------------------------------------------------------

export interface ViewSource {
    src: string;
    mode: 'plain' | 'stream' | 'memory';
    revoke?: () => void;
}

async function fetchCiphertext(fileId: string): Promise<Response> {
    const res = await fetch(streamUrl(fileId), { credentials: 'same-origin', cache: 'no-store' });
    if (!res.ok || !res.body) throw new E2EError(`Could not fetch the encrypted file (HTTP ${res.status})`, 'HTTP');
    return res;
}

/** Decrypts a whole DCE2 file into a Blob in page memory (fallback; capped). */
async function decryptDce2ToBlob(fileId: string, keyStr: string, size: number, type: string): Promise<Blob> {
    if (size > IN_PAGE_DECRYPT_CAP) {
        throw new E2EError(
            `This encrypted file is ${formatMB(size)}. Without the streaming decryptor (a Service Worker, unavailable in this browser mode) ` +
            `in-page decryption is limited to ${formatMB(IN_PAGE_DECRYPT_CAP)}. Open the link in a regular (non-private) window of a current browser, ` +
            'or use Download (streams to disk where the browser supports it).',
            'TOO_LARGE',
        );
    }
    const master = await importMasterKey(keyStr);
    const res = await fetchCiphertext(fileId);
    const len = res.headers.get('content-length');
    const plain = decryptFullStream(master, res.body!, { ciphertextLength: len ? parseInt(len, 10) : undefined });
    const parts: BlobPart[] = [];
    const reader = plain.getReader();
    try {
        for (; ;) {
            const { value, done } = await reader.read();
            if (done) break;
            parts.push(value as Uint8Array<ArrayBuffer>);
        }
    } catch (err) {
        throw integrityMessage(err);
    }
    return new Blob(parts, { type });
}

async function decryptV1ToBlob(fileId: string, keyStr: string, iv: string, type: string): Promise<Blob> {
    const res = await fetchCiphertext(fileId);
    const encrypted = await res.arrayBuffer();
    const key = await Encryption.importKey(keyStr);
    try {
        const plain = await Encryption.decryptBuffer(encrypted, key, Encryption.base64UrlToBytes(iv));
        return new Blob([plain], { type });
    } catch (err) {
        throw integrityMessage(err);
    }
}

/**
 * Resolves a URL the viewer can put in <video>/<audio>/<img>/<iframe>:
 *  - unencrypted: /api/stream (server Range support)
 *  - DCE2: the Service Worker's virtual URL (streams + seeks with bounded memory), else an in-page Blob (capped)
 *  - v1: legacy single-shot decrypt into a Blob
 */
export async function resolveViewSource(fileId: string, meta?: FileMeta | null): Promise<ViewSource> {
    const format = encryptionFormatOf(meta);
    if (!format) return { src: streamUrl(fileId), mode: 'plain' };
    const keyStr = getShareKey(fileId);
    if (!keyStr) throw new E2EError('This file is end-to-end encrypted and the link is missing its #key=... part.', 'NO_KEY');
    const name = displayName(fileId, meta);
    const type = getMimeType(name);

    if (format === 'dce2') {
        if (await prepareWorker(fileId, keyStr, name)) return { src: e2eUrl(fileId, name), mode: 'stream' };
        const blob = await decryptDce2ToBlob(fileId, keyStr, meta?.file_size ?? 0, type);
        const url = URL.createObjectURL(blob);
        return { src: url, mode: 'memory', revoke: () => URL.revokeObjectURL(url) };
    }
    const blob = await decryptV1ToBlob(fileId, keyStr, meta?.encryption_iv ?? '', type);
    const url = URL.createObjectURL(blob);
    return { src: url, mode: 'memory', revoke: () => URL.revokeObjectURL(url) };
}

function clickLink(href: string, name: string) {
    const link = document.createElement('a');
    link.href = href;
    link.download = name;
    link.rel = 'noopener';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

/**
 * Starts a download served by the Service Worker. `<a download>` requests bypass Service Workers in Chromium, so
 * this navigates a hidden iframe instead (navigations in scope are intercepted); the worker answers with
 * Content-Disposition: attachment, and reports failures through 'e2e-error' messages.
 */
function navigateHiddenFrame(href: string) {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.src = href;
    document.body.appendChild(frame);
    setTimeout(() => frame.remove(), 120_000);
}

type SaveFilePicker =(opts: { suggestedName?: string }) => Promise<{
    createWritable(): Promise<WritableStream<Uint8Array> & { abort(reason?: unknown): Promise<void> }>;
}>;

/**
 * Downloads the (decrypted) file. DCE2 streams through the Service Worker; without it, through the File System
 * Access API (written to disk as it decrypts, discarded on any integrity failure); otherwise in memory up to the cap.
 */
export async function downloadFile(fileId: string, meta?: FileMeta | null): Promise<void> {
    const name = displayName(fileId, meta);
    const format = encryptionFormatOf(meta);
    if (!format) {
        clickLink(streamUrl(fileId), name);
        return;
    }
    const keyStr = getShareKey(fileId);
    if (!keyStr) throw new E2EError('This file is end-to-end encrypted and the link is missing its #key=... part.', 'NO_KEY');
    const type = getMimeType(name);

    if (format === 'dce2') {
        if (await prepareWorker(fileId, keyStr, name)) {
            navigateHiddenFrame(e2eUrl(fileId, name, true));
            return;
        }
        const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
        if (picker) {
            const handle = await picker({ suggestedName: name });
            const writable = await handle.createWritable();
            const master = await importMasterKey(keyStr);
            const res = await fetchCiphertext(fileId);
            const len = res.headers.get('content-length');
            try {
                // pipeTo aborts the writable on error, so a failed/tampered download never commits a file.
                await decryptFullStream(master, res.body!, { ciphertextLength: len ? parseInt(len, 10) : undefined }).pipeTo(writable);
            } catch (err) {
                await writable.abort(err).catch(() => undefined);
                throw integrityMessage(err);
            }
            return;
        }
        const blob = await decryptDce2ToBlob(fileId, keyStr, meta?.file_size ?? 0, type);
        const url = URL.createObjectURL(blob);
        clickLink(url, name);
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
    }
    const blob = await decryptV1ToBlob(fileId, keyStr, meta?.encryption_iv ?? '', type);
    const url = URL.createObjectURL(blob);
    clickLink(url, name);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------------------------------------------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------------------------------------------

export interface EncryptedUploadOptions {
    file: File;
    /** base64url link key (goes into the URL fragment; HKDF input only). */
    keyStr: string;
    /** Metadata fields, sent BEFORE the file part. `is_encrypted` / `encryption_format` are added automatically. */
    fields: Array<[string, string]>;
    url?: string;
    chunkSize?: number;
    onProgress?: (fraction: number, phase: 'encrypting' | 'uploading') => void;
    /** Aborts the upload (rejects with an AbortError DOMException). */
    signal?: AbortSignal;
}

export interface UploadResult {
    status: number;
    data: unknown;
    /** 'tus': resumable upload via /api/uploads (src/lib/upload/resumableClient.ts). */
    transport: 'stream' | 'blob' | 'tus';
}

let requestStreamsWork: boolean | null = null;

/** Feature test for fetch() with a ReadableStream body (duplex: 'half'). */
export function supportsRequestStreams(): boolean {
    try {
        let duplexAccessed = false;
        const hasContentType = new Request('data:,', {
            body: new ReadableStream(),
            method: 'POST',
            get duplex() {
                duplexAccessed = true;
                return 'half';
            },
        } as RequestInit).headers.has('Content-Type');
        return duplexAccessed && !hasContentType;
    } catch {
        return false;
    }
}

function escapeQuoted(v: string) {
    return v.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function multipartParts(boundary: string, fields: Array<[string, string]>, filename: string) {
    let pre = '';
    for (const [k, v] of fields) {
        pre += `--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(k)}"\r\n\r\n${v}\r\n`;
    }
    pre += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${escapeQuoted(filename)}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
    const enc = new TextEncoder();
    return { pre: enc.encode(pre), post: enc.encode(`\r\n--${boundary}--\r\n`) };
}

async function uploadStreaming(o: EncryptedUploadOptions, master: CryptoKey, fields: Array<[string, string]>): Promise<UploadResult> {
    const boundary = `----datranE2E${crypto.getRandomValues(new Uint32Array(2)).join('')}`;
    const { pre, post } = multipartParts(boundary, fields, o.file.name);
    const gen = encryptSourceChunks(master, o.file, {
        chunkSize: o.chunkSize,
        onProgress: (done, total) => o.onProgress?.(total ? done / total : 1, 'uploading'),
    });
    let stage: 'pre' | 'body' | 'done' = 'pre';
    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            if (stage === 'pre') {
                controller.enqueue(pre);
                stage = 'body';
                return;
            }
            if (stage === 'body') {
                const next = await gen.next();
                if (!next.done) {
                    controller.enqueue(next.value);
                    return;
                }
                controller.enqueue(post);
                stage = 'done';
            }
            controller.close();
        },
        async cancel() {
            await gen.return(undefined);
        },
    }, { highWaterMark: 2 });
    const res = await fetch(o.url ?? '/api/ingest', {
        method: 'POST',
        body,
        duplex: 'half',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        signal: o.signal,
    } as RequestInit);
    const data = await res.json().catch(() => null);
    return { status: res.status, data, transport: 'stream' };
}

/**
 * Builds the ciphertext as a Blob from encrypted chunk parts. Parts are folded into the Blob every ~16 MiB so the
 * page never holds more than that in ArrayBuffers; browsers keep large Blobs outside the JS heap (on disk if needed).
 */
async function encryptToBlob(o: EncryptedUploadOptions, master: CryptoKey): Promise<Blob> {
    let blob = new Blob([]);
    let parts: BlobPart[] = [];
    let pending = 0;
    for await (const part of encryptSourceChunks(master, o.file, {
        chunkSize: o.chunkSize,
        onProgress: (done, total) => o.onProgress?.(0.5 * (total ? done / total : 1), 'encrypting'),
    })) {
        parts.push(part as Uint8Array<ArrayBuffer>);
        pending += part.length;
        if (pending >= 16 * 1024 * 1024) {
            blob = new Blob([blob, ...parts]);
            parts = [];
            pending = 0;
        }
    }
    return new Blob([blob, ...parts], { type: 'application/octet-stream' });
}

function abortError(): DOMException {
    return new DOMException('Upload aborted', 'AbortError');
}

export function xhrUpload(url: string, form: FormData, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        const xhr = new XMLHttpRequest();
        const onAbort = () => xhr.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        xhr.onloadend = () => signal?.removeEventListener('abort', onAbort);
        xhr.open('POST', url);
        xhr.upload.onprogress = (ev) => {
            if (ev.lengthComputable) onProgress?.(ev.loaded / ev.total);
        };
        xhr.onload = () => {
            let data: unknown = null;
            try {
                data = JSON.parse(xhr.responseText);
            } catch { /* non-JSON error page */ }
            resolve({ status: xhr.status, data });
        };
        xhr.onerror = () => reject(new TypeError('Network error during upload'));
        xhr.onabort = () => reject(abortError());
        xhr.send(form);
    });
}

async function uploadBlob(o: EncryptedUploadOptions, master: CryptoKey, fields: Array<[string, string]>): Promise<UploadResult> {
    const blob = await encryptToBlob(o, master);
    if (o.signal?.aborted) throw abortError();
    if (blob.size !== encryptedSize(o.file.size, o.chunkSize)) throw new Error('Encrypted size mismatch');
    const form = new FormData();
    for (const [k, v] of fields) form.append(k, v);
    form.append('file', blob, o.file.name);
    const res = await xhrUpload(o.url ?? '/api/ingest', form, (f) => o.onProgress?.(0.5 + 0.5 * f, 'uploading'), o.signal);
    return { ...res, transport: 'blob' };
}

/**
 * Encrypts `file` with DCE2 chunk by chunk and uploads it as multipart (fields first, file last). Uses a streaming
 * request body where the browser supports it over this connection (HTTP/2+, i.e. HTTPS); otherwise builds a
 * disk-backed Blob and uploads it with XHR progress.
 */
export async function uploadEncryptedFile(o: EncryptedUploadOptions): Promise<UploadResult> {
    const master = await importMasterKey(o.keyStr);
    const fields: Array<[string, string]> = [...o.fields, ['is_encrypted', 'true'], ['encryption_format', DCE2_FORMAT_FIELD]];
    const tryStreaming = requestStreamsWork !== false && window.location.protocol === 'https:' && supportsRequestStreams();
    if (tryStreaming) {
        try {
            const result = await uploadStreaming(o, master, fields);
            requestStreamsWork = true;
            return result;
        } catch (err) {
            if (o.signal?.aborted) throw abortError();
            // e.g. ERR_H2_OR_QUIC_REQUIRED behind an HTTP/1.1 proxy: remember and fall back for this session.
            if (requestStreamsWork === true) throw err;
            requestStreamsWork = false;
            console.warn('[E2E] Streaming upload unavailable, falling back to Blob upload:', err);
        }
    }
    return uploadBlob(o, master, fields);
}
