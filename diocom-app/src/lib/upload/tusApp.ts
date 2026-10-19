import path from 'path';
import { getRequestUser, AuthTokenError } from '@/lib/auth/requestUser';
import { checkUploadQuota } from '@/lib/billing/enforce';
import { QuotaError } from '@/lib/billing/errors';
import { config } from '@/config';
import { getKV } from '@/lib/kv';
import { getStorageRoot, isInsideRoot } from '@/lib/storage';
import { ReactorStoreUnavailableError } from '@/lib/storage/reactorStore';
import { DatabaseUnavailableError } from '@/db';
import { resolveLocalDbPath } from '@/db/localStore';
import { getClientIdentifier } from '@/lib/rateLimit';
import { validateFileSize, ValidationError } from '@/lib/validation';
import {
    getMaxUploadBytes,
    anonymousUploadsAllowed,
    checkUploadRateLimit,
    rateLimitHeaders,
    validateFileStart,
    parseUploadFields,
    type UploadMeta,
} from '@/lib/upload/policy';
import { finalizeUpload, inspectFile, uploadErrorResponse } from '@/lib/upload/finalize';
import { TusServer, TusError, type TusHooks } from '@/lib/upload/tus/protocol';
import { StagingStore, type TusUploadInfo } from '@/lib/upload/tus/stagingStore';
import { KvLocker } from '@/lib/upload/tus/locker';

/**
 * App wiring of the tus server (src/lib/upload/tus/protocol.ts) at /api/uploads.
 *
 * Env:
 *  - UPLOAD_STAGING_DIR   partial uploads (default ./.upload-staging). Must be outside DIOCOM_STORAGE_PATH and the
 *                         JSON dev DB directory. With several app instances it MUST be shared storage (NFS/EFS/a
 *                         shared volume): consecutive PATCHes of one upload may hit different instances.
 *  - UPLOAD_EXPIRY_HOURS  idle hours after which an unfinished upload expires (default 24); expired uploads are
 *                         deleted by the cleanup job (src/lib/cleanup.ts, leader-locked).
 *  - MAX_UPLOAD_BYTES     same limit as /api/ingest, enforced on Upload-Length and on the received bytes.
 *
 * Upload-Metadata keys (tus-js-client convention + the /api/ingest form fields): filename, filetype, password,
 * tags, summary, is_encrypted, encryption_format, iv. Validation, rate limit (creation only, shared with ingest),
 * anonymous policy and password hashing are exactly those of /api/ingest. The password is hashed at creation and
 * never stored or echoed.
 *
 * Completion: the final PATCH answers with `Diocom-Upload-State: done` and `Diocom-Share-Link: <link>`;
 * `GET /api/uploads/<id>` returns `{ success, link, stats }` like /api/ingest (202 while still in progress).
 */

export const TUS_BASE_PATH = '/api/uploads';
export const SHARE_LINK_HEADER = 'Diocom-Share-Link';

/** Metadata keys never kept with the upload record (nor echoed in HEAD). */
const SECRET_METADATA_KEYS = new Set(['password']);

export function getStagingDir(): string {
    const dir = path.resolve(process.cwd(), process.env.UPLOAD_STAGING_DIR || './.upload-staging');
    const root = getStorageRoot();
    if (dir === root || isInsideRoot(dir, root) || isInsideRoot(root, dir)) {
        throw new Error('UPLOAD_STAGING_DIR must be outside the upload storage directory (DIOCOM_STORAGE_PATH).');
    }
    let dbDir: string | null = null;
    try { dbDir = path.dirname(resolveLocalDbPath()); } catch { /* reported by the DB layer */ }
    if (dbDir && (dir === dbDir || isInsideRoot(dir, dbDir) || isInsideRoot(dbDir, dir))) {
        throw new Error('UPLOAD_STAGING_DIR must not overlap the database directory (LOCAL_DB_PATH).');
    }
    return dir;
}

export function uploadExpiryMs(): number {
    const h = parseFloat(process.env.UPLOAD_EXPIRY_HOURS || '');
    return (Number.isFinite(h) && h > 0 ? h : 24) * 60 * 60_000;
}

interface UploadContext {
    filename: string;
    mimeType: string;
    meta: UploadMeta;
}

function validationToTus(e: unknown): never {
    if (e instanceof QuotaError) {
        throw new TusError(e.status, e.message, e.toJSON());
    }
    if (e instanceof ValidationError) {
        throw new TusError(e.statusCode, e.message, { success: false, message: e.message, code: e.code });
    }
    throw e;
}

/** Session cookie (web) or mobile bearer token; an invalid bearer token is a 401, never anonymous. */
async function requestUserId(req: Request): Promise<string | null> {
    try {
        return (await getRequestUser(req))?.id ?? null;
    } catch (e) {
        if (e instanceof AuthTokenError) {
            throw new TusError(401, e.message, { success: false, message: e.message, code: 'INVALID_TOKEN' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
        }
        throw e;
    }
}

const hooks: TusHooks = {
    async onCreate(req, { length, metadata }) {
        const rl = await checkUploadRateLimit(req);
        if (!rl.allowed) {
            throw new TusError(429, 'Rate limit exceeded', {
                success: false,
                message: `Rate limit exceeded. Try again in ${rl.retryAfter} seconds.`,
                code: 'RATE_LIMIT_EXCEEDED',
                retryAfter: rl.retryAfter,
            }, rateLimitHeaders(rl));
        }
        const userId = await requestUserId(req);
        if (!userId && !anonymousUploadsAllowed()) {
            throw new TusError(401, 'Authentication required', { success: false, message: 'Authentication required', code: 'UNAUTHORIZED' });
        }
        const filename = metadata.filename ?? metadata.name ?? '';
        const mimeType = metadata.filetype ?? metadata.type ?? '';
        let meta: UploadMeta;
        try {
            validateFileStart(filename, mimeType);
            if (config.validation.enableSizeCheck) {
                const v = validateFileSize(length, getMaxUploadBytes());
                if (!v.valid) throw new ValidationError(v.error || 'Invalid file size', v.code || 'INVALID_SIZE', v.code === 'FILE_TOO_LARGE' ? 413 : 400);
            }
            // Plan limits against the declared Upload-Length (file size, storage quota, monthly uploads, password links).
            await checkUploadQuota({ userId, size: length, hasPassword: !!metadata.password?.trim() });
            meta = await parseUploadFields(metadata);
        } catch (e) {
            validationToTus(e);
        }
        const kept: Record<string, string> = {};
        for (const [k, v] of Object.entries(metadata)) {
            if (v !== null && !SECRET_METADATA_KEYS.has(k)) kept[k] = v;
        }
        const context: UploadContext = { filename, mimeType, meta };
        return { ownerId: userId, context: context as unknown as Record<string, unknown>, metadata: kept };
    },

    async authorize(_req, info: TusUploadInfo) {
        // Upload URLs are unguessable capabilities; uploads started by a signed-in user additionally require that user.
        if (info.ownerId && (await requestUserId(_req)) !== info.ownerId) {
            throw new TusError(403, 'Forbidden', { success: false, message: 'Forbidden', code: 'FORBIDDEN' });
        }
    },

    async onComplete(req, info, dataPath) {
        const ctx = info.context as unknown as UploadContext;
        const mimeType = ctx.mimeType || 'application/octet-stream';
        try {
            const inspected = await inspectFile(dataPath, mimeType);
            if (inspected.size !== info.length) throw new Error(`staged upload size mismatch (${inspected.size} != ${info.length})`);
            const result = await finalizeUpload(
                { filename: ctx.filename, mimeType: ctx.mimeType, ...inspected, content: { kind: 'file', path: dataPath } },
                ctx.meta,
                { userId: info.ownerId, requestOrigin: new URL(req.url).origin, clientIp: getClientIdentifier(req) },
            );
            return {
                headers: { [SHARE_LINK_HEADER]: result.link },
                body: { success: true, link: result.link, stats: result.stats },
            };
        } catch (e) {
            const res = uploadErrorResponse(e);
            const body = await res.json().catch(() => ({ success: false, message: 'Internal server error' })) as { message?: string };
            const headers: Record<string, string> = {};
            const retryAfter = res.headers.get('retry-after');
            if (retryAfter) headers['Retry-After'] = retryAfter;
            // Transient backend outages keep the staged bytes so GET <upload url> can finalize later.
            const retryable = e instanceof ReactorStoreUnavailableError || e instanceof DatabaseUnavailableError;
            throw new TusError(res.status, body.message || 'Upload failed', body, headers, retryable);
        }
    },
};

const g = globalThis as typeof globalThis & { __diocomTusServer?: TusServer };

export function getTusServer(): TusServer {
    if (!g.__diocomTusServer) {
        const kv = getKV();
        g.__diocomTusServer = new TusServer({
            basePath: TUS_BASE_PATH,
            store: new StagingStore(getStagingDir(), kv),
            locker: new KvLocker(kv),
            hooks,
            maxSize: getMaxUploadBytes,
            expiryMs: uploadExpiryMs(),
        });
    }
    return g.__diocomTusServer;
}

/** Route handler for every method on /api/uploads and /api/uploads/<id>. */
export async function handleTusRequest(req: Request): Promise<Response> {
    return getTusServer().handle(req);
}

/** Expired / abandoned partial uploads; called by the leader-locked cleanup job. */
export async function sweepExpiredUploads(): Promise<void> {
    const r = await getTusServer().sweepExpired();
    if (r.removed || r.orphans) console.log(`[CLEANUP] Removed ${r.removed} expired partial upload(s), ${r.orphans} orphaned staging file(s).`);
}
