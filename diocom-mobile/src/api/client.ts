import { Platform } from 'react-native';
import { Directory, File as FsFile, Paths, UploadType } from 'expo-file-system';
import type { DocumentPickerAsset } from 'expo-document-picker';

import { getAccessToken } from '../auth/session';

/**
 * Single place where the app talks to the Diocom server. Every request goes through `authHeaders()`, which attaches
 * the signed-in user's bearer token (refreshed as needed by src/auth/session.ts).
 */

export const INGEST_PATH = '/api/ingest';

export interface UploadStats {
    speed?: string;
    ratio?: string;
    engine?: string;
    compression?: number | null;
    compressionEstimated?: boolean;
    dedupPercent?: number | null;
}

export interface UploadSuccess {
    link: string;
    stats?: UploadStats;
}

export interface UploadProgress {
    bytesSent: number;
    totalBytes: number;
}

export interface UploadRequest {
    serverUrl: string;
    asset: DocumentPickerAsset;
    onProgress?: (progress: UploadProgress) => void;
    signal?: AbortSignal;
}

export class ApiError extends Error {
    constructor(
        message: string,
        readonly code: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'ApiError';
    }
}

export class UploadCancelledError extends Error {
    constructor() {
        super('Upload cancelled');
        this.name = 'UploadCancelledError';
    }
}

export function apiUrl(serverUrl: string, path: string): string {
    return `${serverUrl.replace(/\/+$/, '')}${path}`;
}

export async function authHeaders(): Promise<Record<string, string>> {
    const token = await getAccessToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Metadata fields, sent before the file part: the server streams the file as it arrives and may only let the
 * storage reactor sample content when it already knows the upload is neither client-encrypted nor protected.
 * Keep insertion order; both native multipart builders and FormData preserve it.
 */
const METADATA_FIELDS: readonly (readonly [string, string])[] = [
    ['is_encrypted', 'false'],
    ['password', ''],
];

const STATUS_MESSAGES: Record<number, string> = {
    401: 'This server requires sign-in for uploads. Sign in under Settings (or sign in again if your session expired).',
    411: 'The upload was sent without a Content-Length header.',
    429: 'Too many uploads. Wait a moment and try again.',
    503: 'Server storage is temporarily unavailable. Try again shortly.',
    507: 'Server storage is full.',
};

interface IngestResponseBody {
    success?: unknown;
    link?: unknown;
    stats?: unknown;
    message?: unknown;
    code?: unknown;
    upgrade?: unknown;
}

/** Turns a raw HTTP response into a typed result or an ApiError with a message fit for the user. */
export function parseIngestResponse(status: number, body: string): UploadSuccess {
    let data: IngestResponseBody | null = null;
    try {
        const parsed: unknown = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null) data = parsed as IngestResponseBody;
    } catch {
        data = null;
    }

    if (status >= 200 && status < 300 && data?.success === true && typeof data.link === 'string') {
        const stats = typeof data.stats === 'object' && data.stats !== null ? (data.stats as UploadStats) : undefined;
        return { link: data.link, stats };
    }

    const code = typeof data?.code === 'string' ? data.code : status >= 200 && status < 300 ? 'BAD_RESPONSE' : `HTTP_${status}`;
    const serverMessage = typeof data?.message === 'string' ? data.message : undefined;
    const upgrade = typeof data?.upgrade === 'string' ? data.upgrade : undefined;
    // Plan limits (402 quota, 413 file size): the server explains which limit and how to raise it.
    if ((status === 402 || status === 413) && serverMessage) {
        throw new ApiError(upgrade ? `${serverMessage} ${upgrade}` : serverMessage, code, status);
    }
    const message =
        STATUS_MESSAGES[status] ??
        (status === 413 ? 'The file is larger than the server allows.' : undefined) ??
        serverMessage ??
        (data ? `Upload failed (HTTP ${status}).` : `Unexpected response from server (HTTP ${status}). Is the server URL correct?`);
    throw new ApiError(message, code, status);
}

function isAbortError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    return err.name === 'AbortError' || /cancel/i.test(err.message);
}

function networkError(err: unknown): ApiError {
    const detail = err instanceof Error ? err.message : String(err);
    return new ApiError(`Could not reach the server: ${detail}`, 'NETWORK_ERROR');
}

/** Filesystem-safe name that keeps the user's original filename (the server records the part's filename). */
function safeFilename(name: string): string {
    const cleaned = name.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_').trim();
    return cleaned.length > 0 ? cleaned.slice(0, 200) : 'upload';
}

async function uploadNative(req: UploadRequest, url: string, headers: Record<string, string>): Promise<UploadSuccess> {
    const { asset, signal, onProgress } = req;
    // The picker copies into the cache under a random name, and the native multipart builders use the file's own
    // name as the part filename. Move (same volume, a rename) into a private folder under the original name.
    const dir = new Directory(Paths.cache, 'diocom-uploads', `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    try {
        dir.create({ intermediates: true });
        const picked = new FsFile(asset.uri);
        const file = new FsFile(dir, safeFilename(asset.name));
        try {
            await picked.move(file);
        } catch {
            // Not movable (e.g. a content:// URI when copyToCacheDirectory is off): copy instead.
            await picked.copy(file);
        }
        if (signal?.aborted) throw new UploadCancelledError();

        const parameters: Record<string, string> = {};
        for (const [key, value] of METADATA_FIELDS) parameters[key] = value;

        const result = await file.upload(url, {
            httpMethod: 'POST',
            uploadType: UploadType.MULTIPART,
            fieldName: 'file',
            mimeType: asset.mimeType ?? 'application/octet-stream',
            parameters,
            headers: { Accept: 'application/json', ...headers },
            sessionType: 'foreground',
            signal,
            onProgress,
        });
        return parseIngestResponse(result.status, result.body);
    } catch (err) {
        if (err instanceof ApiError || err instanceof UploadCancelledError) throw err;
        if (signal?.aborted || isAbortError(err)) throw new UploadCancelledError();
        throw networkError(err);
    } finally {
        try {
            dir.delete();
        } catch {
            // Already gone or never created; the cache is reclaimable by the OS anyway.
        }
    }
}

function uploadWeb(req: UploadRequest, url: string, headers: Record<string, string>): Promise<UploadSuccess> {
    const { asset, signal, onProgress } = req;
    return new Promise<UploadSuccess>((resolve, reject) => {
        if (!asset.file) {
            reject(new ApiError('The selected file could not be read.', 'NO_FILE'));
            return;
        }
        const form = new FormData();
        for (const [key, value] of METADATA_FIELDS) form.append(key, value);
        form.append('file', asset.file, asset.name);

        const xhr = new XMLHttpRequest();
        const onAbort = () => xhr.abort();
        const cleanup = () => signal?.removeEventListener('abort', onAbort);

        xhr.open('POST', url);
        xhr.setRequestHeader('Accept', 'application/json');
        for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
        if (onProgress) {
            xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) onProgress({ bytesSent: e.loaded, totalBytes: e.total });
            };
        }
        xhr.onload = () => {
            cleanup();
            try {
                resolve(parseIngestResponse(xhr.status, xhr.responseText));
            } catch (err) {
                reject(err);
            }
        };
        xhr.onerror = () => {
            cleanup();
            reject(new ApiError('Could not reach the server (network error or CORS).', 'NETWORK_ERROR'));
        };
        xhr.onabort = () => {
            cleanup();
            reject(new UploadCancelledError());
        };

        if (signal?.aborted) {
            reject(new UploadCancelledError());
            return;
        }
        signal?.addEventListener('abort', onAbort);
        xhr.send(form);
    });
}

/** Uploads one picked document to POST /api/ingest with progress and AbortSignal cancellation. */
export async function uploadDocument(req: UploadRequest): Promise<UploadSuccess> {
    const url = apiUrl(req.serverUrl, INGEST_PATH);
    const headers = await authHeaders();
    return Platform.OS === 'web' ? uploadWeb(req, url, headers) : uploadNative(req, url, headers);
}

/** A file of the signed-in user, as listed by GET /api/mobile/files (public fields only). */
export interface RemoteFile {
    share_id: string;
    original_name: string;
    file_size: number;
    mime_type: string;
    created_at: number;
    expires_at: number | null;
    downloads: number;
    compression_ratio: string | null;
    is_encrypted: number;
    has_password: boolean;
    link: string;
}

/** The signed-in user's uploads on the server. Throws ApiError (401 when the session is gone). */
export async function fetchMyFiles(serverUrl: string): Promise<RemoteFile[]> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    let res: Response;
    try {
        res = await fetch(apiUrl(serverUrl, '/api/mobile/files'), { headers: { Accept: 'application/json', ...headers } });
    } catch (err) {
        throw networkError(err);
    }
    const data: unknown = await res.json().catch(() => null);
    if (res.status === 401) throw new ApiError('Your session expired. Please sign in again.', 'UNAUTHORIZED', 401);
    const files = (data as { files?: unknown } | null)?.files;
    if (!res.ok || !Array.isArray(files)) throw new ApiError(`Could not load your uploads (HTTP ${res.status}).`, `HTTP_${res.status}`, res.status);
    return files as RemoteFile[];
}

/** Reachability check: any HTTP response (even 405 for GET on the ingest route) means the server answered. */
export async function checkServer(serverUrl: string, timeoutMs = 5000): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(apiUrl(serverUrl, INGEST_PATH), {
            method: 'GET',
            headers: await authHeaders(),
            signal: controller.signal,
        });
        return response.status;
    } catch (err) {
        if (controller.signal.aborted) throw new ApiError(`No response within ${timeoutMs / 1000}s.`, 'TIMEOUT');
        throw networkError(err);
    } finally {
        clearTimeout(timer);
    }
}
