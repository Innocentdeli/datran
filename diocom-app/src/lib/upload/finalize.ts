import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { createHash } from 'crypto';
import sharp from 'sharp';
import { config, getShareLinkUrl, shouldCompress } from '@/config';
import { validateFileSize, sanitizeFilename, ValidationError } from '@/lib/validation';
import { FileRepository } from '@/db/files';
import { getStorageProvider, getStorageBackend, removeStoredObject, localPathForKey } from '@/lib/storage';
import { putStoreFile, openStorePutStream, ReactorStoreFullError, ReactorStoreUnavailableError } from '@/lib/storage/reactorStore';
import { toReactorStoragePath, formatStoreRatio, computeStoreRatios, StorePutResult } from '@/lib/storage/reactorStoreCore';
import { sniffFileType, isThumbnailableImage } from '@/lib/upload/multipartStream';
import { getMaxUploadBytes, type UploadMeta } from '@/lib/upload/policy';
import { LedgerService } from '@/lib/ledger';
import { AIService } from '@/lib/ai';
import { AuditLogger } from '@/lib/AuditLogger';
import { WebhookService } from '@/lib/WebhookService';
import { randomToken } from '@/lib/security';
import { compressPayload } from '@/lib/reactorWorker';
import { QuotaError, quotaErrorResponse, formatBytes } from '@/lib/billing/errors';
import { checkUploadQuota } from '@/lib/billing/enforce';
import { resolveExpiryHours } from '@/lib/billing/plans';
import { reserveStorage, releaseStorage, incrementMonthlyUploads, getStorageUsage } from '@/lib/billing/usage';
import { recordQuotaRejection } from '@/lib/observability/metrics';

/**
 * The one finalize path for every upload transport (multipart /api/ingest, resumable tus /api/uploads): store the
 * received bytes in the configured backend (reactor chunk store via a streaming PUT, local disk, or S3), record the
 * ledger hash, thumbnail, DB record, audit + webhook. Anything written before a failure is rolled back.
 */

/** Images above this size get no thumbnail (the image must be buffered for sharp). */
export const THUMBNAIL_MAX_BYTES = 25 * 1024 * 1024;
const HEAD_BYTES = 4096;

/** Where the received bytes are now. */
export type StoredContent =
    /** Already committed (pinned) in the reactor store while the request streamed. */
    | { kind: 'reactor'; put: StorePutResult; durationMs: number }
    /** Small upload held in memory. */
    | { kind: 'buffer'; data: Buffer }
    /** Temp / staging file on local disk. It may be moved into local storage; the caller removes any leftover. */
    | { kind: 'file'; path: string };

export interface ReceivedFile {
    filename: string;
    mimeType: string;
    size: number;
    /** Lowercase hex SHA-256 of the file bytes. */
    sha256: string;
    /** Leading bytes for magic-byte sniffing. */
    head: Buffer;
    /** Whole file for images <= THUMBNAIL_MAX_BYTES, else null. */
    imageBuffer: Buffer | null;
    content: StoredContent;
}

export interface FinalizeContext {
    userId: string | null;
    /** Origin used for the share link (the request's origin). */
    requestOrigin: string;
    clientIp: string;
    /** Pre-chosen share id (default: a fresh random token). */
    shareId?: string;
}

export interface UploadStats {
    speed: string;
    /** Display label, e.g. "2.50x compressed" or "~1.80x compressed · 40% dedup". */
    ratio: string;
    engine: string;
    /** Logical / stored bytes of newly written data (null: nothing new written). */
    compression: number | null;
    compressionEstimated: boolean;
    /** % of chunks already stored (reactor store only). */
    dedupPercent: number | null;
}

export interface FinalizeResult {
    shareId: string;
    link: string;
    stats: UploadStats;
}

/** Unpins content that was committed before finalize ran (e.g. the metadata failed validation). Never throws. */
export async function discardContent(content: StoredContent | null | undefined): Promise<void> {
    if (content?.kind !== 'reactor') return;
    try { await removeStoredObject(toReactorStoragePath(content.put.file_id), false); } catch { /* ignore */ }
}

/**
 * Reads a staged file once: size, SHA-256, head bytes and (images only, up to THUMBNAIL_MAX_BYTES) the whole image
 * for thumbnailing.
 */
export async function inspectFile(filePath: string, mimeType: string): Promise<Pick<ReceivedFile, 'size' | 'sha256' | 'head' | 'imageBuffer'>> {
    const hash = createHash('sha256');
    const isImage = mimeType.toLowerCase().startsWith('image/');
    let size = 0;
    const headParts: Buffer[] = [];
    let headLen = 0;
    let image: Buffer[] | null = isImage ? [] : null;
    for await (const raw of fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
        const chunk = raw as Buffer;
        size += chunk.length;
        hash.update(chunk);
        if (headLen < HEAD_BYTES) {
            const take = chunk.subarray(0, HEAD_BYTES - headLen);
            headParts.push(Buffer.from(take));
            headLen += take.length;
        }
        if (image) {
            if (size <= THUMBNAIL_MAX_BYTES) image.push(chunk);
            else image = null;
        }
    }
    return {
        size,
        sha256: hash.digest('hex'),
        head: Buffer.concat(headParts, headLen),
        imageBuffer: image ? Buffer.concat(image, size) : null,
    };
}

/** Streams a local file into the reactor store (bounded memory; socket backpressure). */
async function streamFileToReactor(filePath: string, opts: { contentType: string; noSample: boolean }): Promise<StorePutResult> {
    const sink = openStorePutStream(opts);
    try {
        for await (const chunk of fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
            await sink.write(chunk as Buffer);
        }
    } catch (e) {
        sink.abort(e instanceof Error ? e : new Error(String(e)));
        throw e;
    }
    return sink.end();
}

/** Moves a temp upload to its final local key (rename, or copy across volumes). Never overwrites. */
async function moveIntoLocalStorage(tempPath: string, key: string): Promise<string> {
    const dest = localPathForKey(key);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) throw new Error('storage object already exists');
    try {
        await fs.promises.rename(tempPath, dest);
    } catch {
        await fs.promises.copyFile(tempPath, dest, fs.constants.COPYFILE_EXCL);
    }
    return dest;
}

/** 507 / 503 responses for reactor store failures; null for anything else. */
export function storeErrorResponse(err: unknown): NextResponse | null {
    if (err instanceof ReactorStoreFullError) {
        console.warn(`[INGEST] Reactor store full: ${JSON.stringify(err.body)}`);
        return NextResponse.json({ success: false, message: err.message, code: 'STORAGE_FULL' }, { status: 507 });
    }
    if (err instanceof ReactorStoreUnavailableError) {
        console.error(`[INGEST] ${err.message}`);
        return NextResponse.json({
            success: false,
            message: 'Storage backend temporarily unavailable. Please try again shortly.',
            code: 'STORAGE_UNAVAILABLE'
        }, { status: 503, headers: { 'Retry-After': '30' } });
    }
    return null;
}

/** Maps any finalize / validation error to the JSON error response clients already understand. */
export function uploadErrorResponse(e: unknown): NextResponse {
    const mapped = storeErrorResponse(e);
    if (mapped) return mapped;
    if (e instanceof QuotaError) return quotaErrorResponse(e);
    if (e instanceof ValidationError) {
        return NextResponse.json({ success: false, message: e.message, code: e.code }, { status: e.statusCode });
    }
    const err = e instanceof Error ? e : new Error(String(e));
    const errorLog = `\n[${new Date().toISOString()}] FATAL INGEST ERROR: ${err.message}\n${err.stack}\n`;
    try {
        fs.mkdirSync(path.dirname(config.debug.debugLogPath), { recursive: true });
        fs.appendFileSync(config.debug.debugLogPath, errorLog);
    } catch { /* ignore */ }
    console.error('[INGEST] Fatal ingestion error:', err.message);
    return NextResponse.json({ success: false, message: 'Internal server error', code: 'INTERNAL_ERROR' }, { status: 500 });
}

/**
 * Stores `file` and creates its share record. Throws ValidationError / reactor store errors / anything else; every
 * object written here (and a reactor put passed in `file.content`) is removed again on failure.
 */
export async function finalizeUpload(file: ReceivedFile, meta: UploadMeta, ctx: FinalizeContext): Promise<FinalizeResult> {
    const storedObjects: string[] = [];
    if (file.content.kind === 'reactor') storedObjects.push(toReactorStoragePath(file.content.put.file_id));
    const storageProvider = getStorageProvider();
    const backend = getStorageBackend();
    const shareID = ctx.shareId ?? randomToken(16);
    let reservedStorage = 0;

    try {
        // Validate file size (empty file etc.); over-limit uploads were already stopped while receiving.
        const maxBytes = getMaxUploadBytes();
        if (config.validation.enableSizeCheck) {
            const sizeValidation = validateFileSize(file.size, maxBytes);
            if (!sizeValidation.valid) {
                throw new ValidationError(sizeValidation.error || 'Invalid file size', sizeValidation.code || 'INVALID_SIZE');
            }
        }

        const { isEncrypted, isDce2, passwordHash } = meta;
        // Plan limits with the real size and the now-known password flag (multipart fields may follow the file).
        const { plan } = await checkUploadQuota({ userId: ctx.userId, size: file.size, hasPassword: passwordHash !== null });
        // Display-safe name (metadata only; never used for on-disk paths)
        const sanitizedName = sanitizeFilename(file.filename);
        const originalName = sanitizedName;
        const mimeType = file.mimeType || 'application/octet-stream';
        const sniffedType = sniffFileType(file.head);

        // Hash-chained upload log (SHA-256 computed while receiving) + MIME-type classification (informational only)
        await LedgerService.recordHash(file.sha256, { filename: sanitizedName, size: file.size, uploader: ctx.userId || 'anon' });
        await AIService.analyze(file.head, mimeType);

        // Thumbnail: only for images whose magic bytes are a raster format and that fit the in-memory cap.
        let thumbBuffer: Buffer | null = null;
        if (mimeType.startsWith('image/') && !isEncrypted && file.imageBuffer && isThumbnailableImage(sniffedType)) {
            try {
                thumbBuffer = await sharp(file.imageBuffer)
                    .resize(400, 400, { fit: 'cover' })
                    .jpeg({ quality: 80 })
                    .toBuffer();
            } catch {
                thumbBuffer = null;
            }
        }

        // Encrypted/protected content is high-entropy and private: never let the reactor sample it.
        const noSample = isEncrypted === 1 || passwordHash !== null;
        const fileSizeMB = file.size / (1024 * 1024);
        // DCE2 ciphertext is incompressible and must stay range-servable from disk (the viewer's Service Worker fetches
        // chunk ranges), so it is never run through the whole-buffer compressor.
        const compress = !isDce2 && shouldCompress(fileSizeMB);
        let ratio = '1.0x';
        let speed = 'Instant';
        let engine = 'none';
        let compressionFactor: number | null = null;
        let compressionEstimated = false;
        let dedupPercent: number | null = null;
        let reactorClass: string | null = null;
        let reactorRecipe: string | null = null;
        let finalStoragePath: string;

        if (backend === 'reactor') {
            // Reactor chunked object store (NETWORK_SPEC §2): the store chunks, dedups and compresses per chunk with the
            // evolved class recipes, so the legacy /compress path is skipped.
            let put: StorePutResult;
            let durationMs: number;
            const content = file.content;
            if (content.kind === 'reactor') {
                put = content.put;
                durationMs = content.durationMs;
            } else {
                const startTime = Date.now();
                if (content.kind === 'file') {
                    put = await streamFileToReactor(content.path, { contentType: mimeType, noSample });
                } else {
                    const buf = content.data;
                    put = await putStoreFile(new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength), {
                        contentType: mimeType,
                        noSample,
                    });
                }
                storedObjects.push(toReactorStoragePath(put.file_id)); // rollback = unpin
                durationMs = Date.now() - startTime;
            }
            finalStoragePath = toReactorStoragePath(put.file_id);
            if (put.size !== file.size) {
                throw new Error(`reactor store size mismatch (${put.size} != ${file.size})`);
            }
            if (put.file_id !== file.sha256) {
                throw new Error('reactor store content hash mismatch');
            }
            const durationSec = Math.max(durationMs / 1000, 0.001);
            speed = `${(fileSizeMB / durationSec).toFixed(2)} MB/s`;
            ratio = formatStoreRatio(put);
            ({ compression: compressionFactor, compressionEstimated, dedupPercent } = computeStoreRatios(put));
            engine = 'reactor_store';
            reactorClass = put.class;
            console.log(`[INGEST] Stored in reactor store${put.class ? ` [${put.class}]` : ''}: ${put.file_id.slice(0, 12)}… ` +
                `${put.size}B -> +${put.stored_bytes}B (${put.new_chunks} new / ${put.dedup_chunks} dedup chunks${put.duplicate ? ', duplicate' : ''}; ${ratio})`);
        } else {
            const content = file.content;
            if (content.kind === 'reactor') throw new Error('reactor content with a non-reactor storage backend');
            const tempPath = content.kind === 'file' ? content.path : null;
            if (!compress && tempPath && !storageProvider.isExternal()) {
                // Uncompressed local object streamed to a temp file: move it into place without buffering.
                finalStoragePath = await moveIntoLocalStorage(tempPath, shareID);
                storedObjects.push(finalStoragePath);
            } else {
                // Compression (reactor /compress or TS fallback) and S3 uploads take a buffer, as before.
                const buffer = tempPath ? await fs.promises.readFile(tempPath) : (content as { data: Buffer }).data;
                if (buffer.length !== file.size) throw new Error('temp upload size mismatch');
                let payload: Buffer = buffer;
                if (compress) {
                    const startTime = Date.now();
                    const result = await compressPayload(buffer, { contentType: mimeType, noSample });
                    payload = result.data;
                    engine = result.engine;
                    reactorClass = result.reactorClass ?? null;
                    reactorRecipe = result.reactorRecipe ?? null;
                    const durationSec = result.timeUs !== undefined
                        ? Math.max(result.timeUs / 1_000_000, 0.0001)
                        : Math.max((Date.now() - startTime) / 1000, 0.001);
                    speed = `${(fileSizeMB / durationSec).toFixed(2)} MB/s`;
                    // Actual stored sizes (container header included); never collides with the uncompressed '1.0x' marker.
                    compressionFactor = buffer.length / Math.max(payload.length, 1);
                    ratio = `${compressionFactor.toFixed(2)}x compressed`;
                    console.log(`[INGEST] Compressed via ${engine}${reactorClass ? ` [${reactorClass}]` : ''}: ${buffer.length}B -> ${payload.length}B (${ratio})`);
                }
                // Persist (local disk under the storage root, or S3) — no stray local copies in S3 mode.
                finalStoragePath = await storageProvider.upload(payload, shareID, compress ? 'application/octet-stream' : mimeType);
                storedObjects.push(finalStoragePath);
            }
        }

        let finalThumbPath: string | null = null;
        if (thumbBuffer) {
            finalThumbPath = await storageProvider.upload(thumbBuffer, `${shareID}.thumb.jpg`, 'image/jpeg');
            storedObjects.push(finalThumbPath);
        }
        // Reactor-backed records are served by this app (proxy), never redirected.
        const isExternal = backend !== 'reactor' && storageProvider.isExternal() ? 1 : 0;

        // Storage quota: atomic reservation (concurrent uploads cannot overshoot); released again on any failure below.
        if (ctx.userId) {
            if (!(await reserveStorage(ctx.userId, file.size, plan.storageQuotaBytes))) {
                const { storageBytes } = await getStorageUsage(ctx.userId);
                recordQuotaRejection('storage', plan.id);
                throw new QuotaError('storage',
                    `Storage quota exceeded: ${formatBytes(storageBytes)} of ${formatBytes(plan.storageQuotaBytes)} used; this file needs ${formatBytes(file.size)}.`,
                    plan.id, { limitBytes: plan.storageQuotaBytes, usedBytes: storageBytes, requestedBytes: file.size });
            }
            reservedStorage = file.size;
        }

        console.log(`[INGEST] Saving ${shareID} to database...`);
        await FileRepository.create({
            share_id: shareID,
            user_id: ctx.userId || null,
            original_name: originalName,
            sanitized_name: sanitizedName,
            storage_path: finalStoragePath,
            thumbnail_path: finalThumbPath,
            password_hash: passwordHash,
            is_external: isExternal,
            file_size: file.size,
            mime_type: mimeType,
            expires_at: Date.now() + Math.round(resolveExpiryHours(plan, meta.expiresInHours) * 3_600_000),
            compression_ratio: ratio, // display label: compression and dedup reported separately (formatStoreRatio)
            compression_speed: speed,
            tags: meta.tagsRaw,
            summary: meta.summary,
            is_encrypted: isEncrypted,
            encryption_iv: meta.encryptionIv,
            similarity_token: meta.similarityToken,
        });
        storedObjects.length = 0; // committed
        reservedStorage = 0; // now owned by the file record (released when it is deleted / expires)
        if (ctx.userId) {
            await incrementMonthlyUploads(ctx.userId).catch((err) => console.error('[INGEST] monthly upload counter failed:', err instanceof Error ? err.message : err));
        }

        if (reactorClass || reactorRecipe) {
            // Best effort: informational metadata only; older databases may lack these columns.
            await FileRepository.setReactorMeta(shareID, reactorClass, reactorRecipe);
        }

        await AuditLogger.record({
            userId: ctx.userId ?? undefined,
            action: 'FILE_UPLOAD',
            resource: shareID,
            details: `${engine === 'reactor_store' ? 'Reactor store' : compress ? 'Compressed' : 'Uncompressed'} upload (${file.size} bytes). Storage: ${ratio}. Client-encrypted: ${isEncrypted === 1}`,
            ipAddress: ctx.clientIp,
        });

        if (compress) {
            await WebhookService.dispatch('file.uploaded', {
                shareId: shareID,
                ownerId: ctx.userId ?? undefined,
                filename: originalName,
                size: file.size,
                encrypted: isEncrypted === 1
            });
        }

        return {
            shareId: shareID,
            link: getShareLinkUrl(shareID, ctx.requestOrigin),
            stats: { speed, ratio, engine, compression: compressionFactor, compressionEstimated, dedupPercent },
        };
    } catch (e) {
        // Roll back any objects written (and storage reserved) before the failure
        if (reservedStorage && ctx.userId) {
            await releaseStorage(ctx.userId, reservedStorage).catch(() => undefined);
        }
        for (const loc of storedObjects) {
            try { await removeStoredObject(loc, storageProvider.isExternal()); } catch { /* ignore */ }
        }
        throw e;
    }
}
