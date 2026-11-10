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
    password?: string;
    expiresInHours?: number;
    background?: boolean;
    maxRetries?: number;
    onProgress?: (progress: UploadProgress) => void;
    onStatusChange?: (status: 'uploading' | 'reconnecting' | 'resuming', attempt?: number) => void;
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
 * Builds metadata fields to send before the file part.
 * Includes password and link expiration options matching the web client.
 */
function buildMetadataFields(req: UploadRequest): [string, string][] {
    const fields: [string, string][] = [
        ['is_encrypted', 'false'],
        ['password', req.password ?? ''],
    ];
    if (req.expiresInHours && req.expiresInHours > 0) {
        fields.push(['expires_in_hours', String(req.expiresInHours)]);
    }
    return fields;
}

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
    const { asset, signal, onProgress, onStatusChange } = req;
    const maxRetries = req.maxRetries ?? 5;
    const sessionType = req.background !== false ? 'background' : 'foreground';

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
        for (const [key, value] of buildMetadataFields(req)) parameters[key] = value;

        let attempt = 0;
        while (true) {
            try {
                if (attempt > 0) {
                    onStatusChange?.('resuming', attempt);
                } else {
                    onStatusChange?.('uploading', 0);
                }

                const result = await file.upload(url, {
                    httpMethod: 'POST',
                    uploadType: UploadType.MULTIPART,
                    fieldName: 'file',
                    mimeType: asset.mimeType ?? 'application/octet-stream',
                    parameters,
                    headers: { Accept: 'application/json', ...headers },
                    sessionType,
                    signal,
                    onProgress,
                });
                return parseIngestResponse(result.status, result.body);
            } catch (err) {
                if (signal?.aborted || isAbortError(err)) throw new UploadCancelledError();
                if (err instanceof UploadCancelledError) throw err;
                if (err instanceof ApiError && err.status && err.status >= 400 && err.status < 500 && err.status !== 408) {
                    // Non-retryable client error (e.g. 401, 403, 413)
                    throw err;
                }

                attempt++;
                if (attempt > maxRetries) {
                    if (err instanceof ApiError) throw err;
                    throw networkError(err);
                }

                // Transient network disconnect (Wi-Fi <-> 5G switch or momentary signal drop)
                onStatusChange?.('reconnecting', attempt);
                const backoffMs = Math.min(1000 * Math.pow(1.6, attempt), 8000);
                await new Promise<void>((resolve, reject) => {
                    const timer = setTimeout(resolve, backoffMs);
                    if (signal) {
                        const onAbort = () => {
                            clearTimeout(timer);
                            reject(new UploadCancelledError());
                        };
                        signal.addEventListener('abort', onAbort, { once: true });
                    }
                });
            }
        }
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
        for (const [key, value] of buildMetadataFields(req)) form.append(key, value);
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

export interface BillingUsageSummary {
    plan: {
        id: 'anonymous' | 'free' | 'pro';
        name: string;
        maxFileBytes: number;
        maxExpiryHours: number;
        defaultExpiryHours: number;
        passwordLinks: boolean;
    };
    usage?: {
        storageBytes: number;
        storageQuotaBytes: number | null;
        uploadsThisMonth: number;
        monthlyUploads: number | null;
    };
}

/** Fetches current account billing summary and quotas when signed in. */
export async function fetchBillingUsage(serverUrl: string): Promise<BillingUsageSummary | null> {
    try {
        const headers = await authHeaders();
        if (!headers.Authorization) return null;
        const res = await fetch(apiUrl(serverUrl, '/api/billing/usage'), {
            headers: { Accept: 'application/json', ...headers },
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data as BillingUsageSummary;
    } catch {
        return null;
    }
}

/* ====================================================================
 * LIVE LOBBY CLIENT API (/lobby)
 * ==================================================================== */

export interface LobbyFileItem {
    shareId: string;
    name: string;
    size: number;
    mimeType: string | null;
    hasPassword?: boolean;
}

export interface LobbyState {
    status: 'waiting' | 'active' | 'transferring' | 'complete' | 'expired';
    code: string;
    expiresAt: number;
    role: 'creator' | 'joiner' | null;
    files: LobbyFileItem[];
}

export async function createLobby(serverUrl: string): Promise<{ code: string; expiresAt: number; token?: string }> {
    const headers = await authHeaders();
    const res = await fetch(apiUrl(serverUrl, '/api/lobby/create'), {
        method: 'POST',
        headers: { Accept: 'application/json', ...headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.code) throw new ApiError(data?.error ?? 'Could not create lobby', 'LOBBY_CREATE_FAILED', res.status);
    return data;
}

export async function joinLobby(serverUrl: string, code: string): Promise<{ status: string; token?: string }> {
    const headers = await authHeaders();
    const res = await fetch(apiUrl(serverUrl, `/api/lobby/${code.toUpperCase()}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ action: 'join' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not join lobby', 'LOBBY_JOIN_FAILED', res.status);
    return data;
}

export async function fetchLobbyState(serverUrl: string, code: string, lobbyToken?: string): Promise<LobbyState> {
    const auth = await authHeaders();
    const customHeaders: Record<string, string> = { Accept: 'application/json', ...auth };
    if (lobbyToken) customHeaders['x-lobby-token'] = lobbyToken;

    const res = await fetch(apiUrl(serverUrl, `/api/lobby/${code.toUpperCase()}`), {
        headers: customHeaders,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.error ?? 'Lobby not found', 'LOBBY_GET_FAILED', res.status);
    return {
        status: data.status,
        code: data.code,
        expiresAt: Number(data.expiresAt) || 0,
        role: data.role ?? null,
        files: Array.isArray(data.files) ? data.files : [],
    };
}

export async function addFilesToLobby(serverUrl: string, code: string, shareIds: string[], lobbyToken?: string): Promise<LobbyFileItem[]> {
    const auth = await authHeaders();
    const customHeaders: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', ...auth };
    if (lobbyToken) customHeaders['x-lobby-token'] = lobbyToken;

    const res = await fetch(apiUrl(serverUrl, `/api/lobby/${code.toUpperCase()}`), {
        method: 'PATCH',
        headers: customHeaders,
        body: JSON.stringify({ action: 'add_files', shareIds }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not drop files into lobby', 'LOBBY_ADD_FILES_FAILED', res.status);
    return data.files || [];
}

export async function completeLobby(serverUrl: string, code: string, lobbyToken?: string): Promise<void> {
    const auth = await authHeaders();
    const customHeaders: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json', ...auth };
    if (lobbyToken) customHeaders['x-lobby-token'] = lobbyToken;

    await fetch(apiUrl(serverUrl, `/api/lobby/${code.toUpperCase()}`), {
        method: 'PATCH',
        headers: customHeaders,
        body: JSON.stringify({ action: 'complete' }),
    });
}

/* ====================================================================
 * DIRECT USER INBOX CLIENT API (/inbox)
 * ==================================================================== */

export interface InboxItem {
    id: string;
    sender_id: string;
    recipient_id: string;
    file_id: string;
    status: 'pending' | 'accepted' | 'declined';
    message: string | null;
    created_at: number;
    sender_name?: string;
    sender_username?: string;
    sender_image?: string;
    original_name?: string;
    file_size?: number;
    mime_type?: string;
    share_id?: string;
}

export interface UserHandleResult {
    id: string;
    name: string;
    username: string;
    image?: string;
}

export async function fetchInboxTransfers(serverUrl: string): Promise<{ items: InboxItem[]; pendingCount: number }> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, '/api/inbox'), { headers: { Accept: 'application/json', ...headers } });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.error ?? 'Could not load inbox', 'INBOX_GET_FAILED', res.status);
    return {
        items: Array.isArray(data?.items) ? data.items : [],
        pendingCount: Number(data?.pendingCount) || 0,
    };
}

export async function searchHandles(serverUrl: string, query: string): Promise<UserHandleResult[]> {
    const headers = await authHeaders();
    if (!headers.Authorization) return [];
    const clean = query.replace(/^@/, '').trim();
    if (!clean) return [];
    const res = await fetch(apiUrl(serverUrl, `/api/inbox/send?q=${encodeURIComponent(clean)}`), {
        headers: { Accept: 'application/json', ...headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return [];
    return Array.isArray(data?.results) ? data.results : [];
}

export async function sendFileToHandle(serverUrl: string, handle: string, shareId: string, message?: string): Promise<void> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Sign in to send files to users.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, '/api/inbox/send'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ handle: handle.replace(/^@/, '').trim(), shareId, message: message?.trim() || undefined }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not send file', 'INBOX_SEND_FAILED', res.status);
}

export async function respondToInboxTransfer(serverUrl: string, id: string, action: 'accept' | 'decline'): Promise<void> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, `/api/inbox/${id}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ action }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? `Could not ${action} transfer`, 'INBOX_UPDATE_FAILED', res.status);
}

/* ====================================================================
 * SHARED SPACES CLIENT API (/spaces)
 * ==================================================================== */

export interface SpaceItem {
    id: string;
    owner_id: string;
    name: string;
    slug: string;
    description: string | null;
    is_public: number;
    created_at: number;
}

export interface SpaceMember {
    id: string;
    name: string;
    username: string;
    image: string | null;
    role: string;
}

export interface SpaceFile {
    share_id: string;
    original_name: string;
    file_size: number;
    mime_type: string;
    uploader_name: string;
    uploaded_at: number;
    downloads?: number;
    link?: string;
}

export async function fetchSpacesList(serverUrl: string): Promise<{ owned: SpaceItem[]; member: SpaceItem[] }> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, '/api/spaces'), {
        headers: { Accept: 'application/json', ...headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(data?.error ?? 'Could not load spaces', 'SPACES_GET_FAILED', res.status);
    return {
        owned: Array.isArray(data?.owned) ? data.owned : [],
        member: Array.isArray(data?.member) ? data.member : [],
    };
}

export async function createNewSpace(serverUrl: string, params: { name: string; description?: string; isPublic?: boolean }): Promise<{ id: string; slug: string }> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Sign in to create a space.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, '/api/spaces'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not create space', 'SPACES_CREATE_FAILED', res.status);
    return data;
}

export async function fetchSpaceDetail(serverUrl: string, slug: string): Promise<{ space: SpaceItem; members: SpaceMember[]; files: SpaceFile[] }> {
    const headers = await authHeaders();
    const res = await fetch(apiUrl(serverUrl, `/api/spaces/${slug}`), {
        headers: { Accept: 'application/json', ...headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not load space details', 'SPACES_DETAIL_FAILED', res.status);
    return {
        space: data.space,
        members: Array.isArray(data.members) ? data.members : [],
        files: Array.isArray(data.files) ? data.files : [],
    };
}

export async function addFileToSpace(serverUrl: string, slug: string, shareId: string): Promise<void> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, `/api/spaces/${slug}/files`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ shareId }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not attach file to space', 'SPACE_FILE_ADD_FAILED', res.status);
}

export async function deleteSpace(serverUrl: string, slug: string): Promise<void> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, `/api/spaces/${slug}`), {
        method: 'DELETE',
        headers: { Accept: 'application/json', ...headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not delete space', 'SPACE_DELETE_FAILED', res.status);
}

/* ==========================================================================
 * EMAIL DELIVERY & TRACKING API (/api/transfers/[id])
 * ========================================================================== */

export interface RecipientStatus {
    id: string;
    recipient_email: string;
    status: 'sent' | 'delivered' | 'opened' | 'downloaded' | 'failed';
    sent_at: number;
    opened_at: number | null;
    downloaded_at: number | null;
}

export interface DeliveryTrackingResponse {
    success: boolean;
    require_email_otp: boolean;
    sender_email: string | null;
    custom_message: string | null;
    recipients: RecipientStatus[];
}

export async function sendTransferEmail(
    serverUrl: string,
    fileId: string,
    params: {
        recipients: string[];
        message?: string;
        requireOtp?: boolean;
        link?: string;
    }
): Promise<{ success: boolean; sentCount: number }> {
    const headers = await authHeaders();
    const res = await fetch(apiUrl(serverUrl, `/api/transfers/${fileId}/email`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not send transfer emails', 'EMAIL_SEND_FAILED', res.status);
    return data;
}

export async function fetchDeliveryTracking(serverUrl: string, fileId: string): Promise<DeliveryTrackingResponse> {
    const headers = await authHeaders();
    const res = await fetch(apiUrl(serverUrl, `/api/transfers/${fileId}/tracking`), {
        headers: { Accept: 'application/json', ...headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not fetch tracking data', 'TRACKING_FAILED', res.status);
    return data;
}

/* ==========================================================================
 * FILE REQUESTS API (/api/requests)
 * ========================================================================== */

export interface FileRequestItem {
    id: string;
    title: string;
    description: string | null;
    slug: string;
    destination_folder: string | null;
    has_password: boolean;
    is_active: boolean;
    expires_at: number | null;
    created_at: number;
    upload_count: number;
    total_bytes: number;
}

export async function fetchFileRequests(serverUrl: string): Promise<FileRequestItem[]> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, '/api/requests'), {
        headers: { Accept: 'application/json', ...headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not load file requests', 'REQUESTS_GET_FAILED', res.status);
    return data.requests || [];
}

export async function createFileRequest(
    serverUrl: string,
    params: {
        title: string;
        description?: string;
        customSlug?: string;
        password?: string;
        expiresInDays?: number;
    }
): Promise<FileRequestItem> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, '/api/requests'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(params),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not create file request', 'REQUEST_CREATE_FAILED', res.status);
    return data.request;
}

export async function toggleFileRequest(serverUrl: string, requestId: string, isActive: boolean): Promise<void> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, '/api/requests'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ id: requestId, is_active: isActive }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not update file request', 'REQUEST_UPDATE_FAILED', res.status);
}

export async function deleteFileRequest(serverUrl: string, requestId: string): Promise<void> {
    const headers = await authHeaders();
    if (!headers.Authorization) throw new ApiError('Not signed in.', 'UNAUTHORIZED', 401);
    const res = await fetch(apiUrl(serverUrl, '/api/requests'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify({ id: requestId, action: 'delete' }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not delete file request', 'REQUEST_DELETE_FAILED', res.status);
}

/* ==========================================================================
 * REVIEWS & COMMENTS API (/api/transfers/[id]/reviews)
 * ========================================================================== */

export interface ReviewItem {
    id: string;
    reviewer_name: string;
    reviewer_email: string;
    status: 'approved' | 'changes_requested' | 'pending';
    decision_note: string | null;
    updated_at: number;
}

export interface ReviewCommentItem {
    id: string;
    reviewer_name: string;
    reviewer_email: string;
    comment: string;
    timestamp: number | null;
    resolved: boolean;
    created_at: number;
}

export async function fetchFileReviews(
    serverUrl: string,
    fileId: string
): Promise<{ reviews: ReviewItem[]; comments: ReviewCommentItem[] }> {
    const headers = await authHeaders();
    const res = await fetch(apiUrl(serverUrl, `/api/transfers/${fileId}/reviews`), {
        headers: { Accept: 'application/json', ...headers },
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.success) throw new ApiError(data?.error ?? 'Could not fetch reviews', 'REVIEWS_GET_FAILED', res.status);
    return {
        reviews: data.reviews || [],
        comments: data.comments || [],
    };
}

