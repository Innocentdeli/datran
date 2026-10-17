import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';
import { config, getShareLinkUrl, shouldCompress } from '@/config';
import {
    validateFileSize,
    validateFileType,
    validateMimeType,
    sanitizeFilename,
    ValidationError
} from '@/lib/validation';
import { checkRateLimit, getClientIdentifier } from '@/lib/rateLimit';
import { getServerSession } from 'next-auth';
import { authOptions } from '../auth/[...nextauth]/route';
import { FileRepository } from '@/db/files';
import sharp from 'sharp';
import { getStorageProvider, getStorageBackend, removeStoredObject, getStorageRoot, localPathForKey } from '@/lib/storage';
import { putStoreFile, openStorePutStream, ReactorStoreFullError, ReactorStoreUnavailableError } from '@/lib/storage/reactorStore';
import { toReactorStoragePath, formatStoreRatio, computeStoreRatios, StorePutResult } from '@/lib/storage/reactorStoreCore';
import {
    parseMultipartUpload,
    ParsedUpload,
    UploadSink,
    UploadTooLargeError,
    MultipartError,
    sniffFileType,
    isThumbnailableImage,
    mayStreamSample,
} from '@/lib/upload/multipartStream';
import { LedgerService } from '@/lib/ledger';
import { AIService } from '@/lib/ai';
import { ACSNode } from '../../../../../src/network/ACSNode';
import { AuditLogger } from '@/lib/AuditLogger';
import { WebhookService } from '@/lib/WebhookService';
import { FHELight } from '@/lib/FHELight';
import { hashPassword, randomToken } from '@/lib/security';
import { compressPayload } from '@/lib/reactorWorker';
import { DCE2_DB_MARKER, DCE2_FORMAT_FIELD } from '@/lib/crypto/dce2';
import { createProgressReporter, isValidUploadId, type ProgressReporter } from '@/lib/uploadProgress';
import '@/db/schema'; // Initialize DB Schema

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const globalNode = new ACSNode(); // Persistent node for the server lifecycle

const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB
const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Files up to this size are held in memory until the whole form is parsed (flags known); larger ones stream. */
const DEFER_BYTES = 8 * 1024 * 1024;
/** Images above this size get no thumbnail (the image must be buffered for sharp). */
const THUMBNAIL_MAX_BYTES = 25 * 1024 * 1024;
const MAX_FIELD_BYTES = 1024 * 1024;

function countedBody(src: Readable, progress: ProgressReporter | null): Readable {
    if (!progress) return src;
    const counter = progress.counter();
    src.on('error', (e) => counter.destroy(e));
    return src.pipe(counter);
}

type SinkResult = { kind: 'reactor'; put: StorePutResult } | { kind: 'temp'; path: string };

/** Effective upload limit: MAX_UPLOAD_BYTES (default 200MB), never above config.storage.maxFileSize. */
function getMaxUploadBytes(): number {
    const env = parseInt(process.env.MAX_UPLOAD_BYTES || '', 10);
    const limit = Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_UPLOAD_BYTES;
    return Math.min(limit, config.storage.maxFileSize);
}

/** ALLOW_ANONYMOUS_UPLOADS defaults to true for dev compatibility; set to 'false' to require login. */
function anonymousUploadsAllowed(): boolean {
    return process.env.ALLOW_ANONYMOUS_UPLOADS !== 'false';
}

function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    const trimmed = raw.trim();
    let tags: unknown = null;
    if (trimmed.startsWith('[')) {
        try {
            tags = JSON.parse(trimmed);
        } catch {
            throw new ValidationError('Invalid tags format', 'INVALID_TAGS');
        }
        if (!Array.isArray(tags)) throw new ValidationError('Invalid tags format', 'INVALID_TAGS');
    } else {
        tags = trimmed.split(',');
    }
    return (tags as unknown[])
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.trim().slice(0, 64))
        .filter(Boolean)
        .slice(0, 50);
}

function tooLarge(maxBytes: number) {
    return NextResponse.json({
        success: false,
        message: `File exceeds maximum allowed size (${Math.floor(maxBytes / (1024 * 1024))}MB)`,
        code: 'FILE_TOO_LARGE'
    }, { status: 413 });
}

/** 507 / 503 responses for reactor store failures; null for anything else. */
function storeErrorResponse(err: unknown): NextResponse | null {
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

/** Name/MIME checks that need only the part headers: run before any byte is stored. */
function validateFileStart(filename: string, mimeType: string): void {
    const sanitizedName = sanitizeFilename(filename);
    if (config.validation.enableTypeCheck && config.storage.allowedExtensions[0] !== '*') {
        const typeValidation = validateFileType(sanitizedName, config.storage.allowedExtensions);
        if (!typeValidation.valid) throw new ValidationError(typeValidation.error || 'File type not allowed', typeValidation.code || 'INVALID_TYPE');
    }
    if (config.validation.enableMimeCheck) {
        const mimeValidation = validateMimeType(mimeType, config.validation.allowedMimeTypes);
        if (!mimeValidation.valid) throw new ValidationError(mimeValidation.error || 'MIME type not allowed', mimeValidation.code || 'INVALID_MIME');
    }
}

/** Local/S3 backends: stream the file to a temp file under the storage root (same volume, so it can be renamed). */
function openTempFileSink(shareID: string, tempFiles: string[]): UploadSink<SinkResult> {
    const dir = path.join(getStorageRoot(), '.ingest-tmp');
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `${shareID}.part`);
    tempFiles.push(tmp);
    const out = fs.createWriteStream(tmp, { flags: 'wx' });
    let error: Error | null = null;
    out.on('error', (e) => { error = e; });
    return {
        async write(chunk) {
            if (error) throw error;
            if (!out.write(chunk)) {
                await new Promise<void>((resolve, reject) => {
                    const onDrain = () => { out.off('error', onError); resolve(); };
                    const onError = (e: Error) => { out.off('drain', onDrain); reject(e); };
                    out.once('drain', onDrain);
                    out.once('error', onError);
                });
            }
        },
        end: () => new Promise<SinkResult>((resolve, reject) => {
            if (error) { reject(error); return; }
            out.once('error', reject);
            out.end(() => resolve({ kind: 'temp', path: tmp }));
        }),
        abort() { out.destroy(); },
    };
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

/**
 * Optional progress reporting: if the client sends `x-upload-id` (or `?uploadId=`), body bytes are counted and
 * published to the shared KV for GET /api/progress (which may be served by another instance).
 */
export async function POST(request: Request) {
    const rawId = request.headers.get('x-upload-id') ?? new URL(request.url).searchParams.get('uploadId');
    const total = Number(request.headers.get('content-length'));
    const progress = isValidUploadId(rawId) ? createProgressReporter(rawId, Number.isFinite(total) && total > 0 ? total : null) : null;
    let res: Response;
    try {
        res = await handleIngest(request, progress);
    } catch (e) {
        await progress?.fail('Upload failed');
        throw e;
    }
    if (progress) {
        if (res.ok) await progress.done();
        else await progress.fail(`Upload failed (${res.status})`);
    }
    return res;
}

async function handleIngest(request: Request, progress: ProgressReporter | null): Promise<Response> {
    console.log(`[INGEST] Incoming request at ${new Date().toISOString()}`);
    const storedObjects: string[] = [];
    const tempFiles: string[] = [];
    const storageProvider = getStorageProvider();

    try {
        // Rate limiting
        if (config.rateLimit.enabled) {
            const clientId = getClientIdentifier(request);
            const rateLimitResult = await checkRateLimit(`ingest:${clientId}`, {
                maxRequests: config.rateLimit.maxRequests,
                windowMs: config.rateLimit.windowMs
            });

            if (!rateLimitResult.allowed) {
                return NextResponse.json({
                    success: false,
                    message: `Rate limit exceeded. Try again in ${rateLimitResult.retryAfter} seconds.`,
                    code: 'RATE_LIMIT_EXCEEDED',
                    retryAfter: rateLimitResult.retryAfter
                }, {
                    status: 429,
                    headers: {
                        'X-RateLimit-Limit': config.rateLimit.maxRequests.toString(),
                        'X-RateLimit-Remaining': '0',
                        'X-RateLimit-Reset': new Date(rateLimitResult.resetAt).toISOString(),
                        'Retry-After': rateLimitResult.retryAfter?.toString() || '60'
                    }
                });
            }
        }

        // Session (needed before buffering for the anonymous-upload gate)
        const session = await getServerSession(authOptions);
        const userId = session?.user?.id;
        if (!userId && !anonymousUploadsAllowed()) {
            return NextResponse.json({ success: false, message: 'Authentication required', code: 'UNAUTHORIZED' }, { status: 401 });
        }

        // Cheap pre-check; the limit is also enforced byte-by-byte while streaming.
        const maxBytes = getMaxUploadBytes();
        const contentLength = Number(request.headers.get('content-length'));
        if (!request.headers.get('content-length') || !Number.isFinite(contentLength)) {
            return NextResponse.json({ success: false, message: 'Content-Length required', code: 'LENGTH_REQUIRED' }, { status: 411 });
        }
        if (contentLength > maxBytes + MULTIPART_OVERHEAD_BYTES) {
            return tooLarge(maxBytes);
        }

        if (!request.body) {
            return NextResponse.json({ success: false, message: 'Invalid form data', code: 'BAD_REQUEST' }, { status: 400 });
        }
        const contentType = request.headers.get('content-type') || '';
        if (!/^multipart\/form-data/i.test(contentType)) {
            return NextResponse.json({ success: false, message: 'Invalid form data', code: 'BAD_REQUEST' }, { status: 400 });
        }

        const backend = getStorageBackend();
        // Random, unguessable share id; also used as the storage key.
        const shareID = randomToken(16);
        let streamStart = 0;

        // Streaming parse: the file part is hashed/sniffed as it arrives; files above DEFER_BYTES go straight to the
        // reactor store (chunked PUT) or a temp file, so server memory is bounded regardless of file size.
        let parsed: ParsedUpload<SinkResult>;
        try {
            parsed = await parseMultipartUpload<SinkResult>(
                countedBody(Readable.fromWeb(request.body as unknown as NodeWebReadableStream<Uint8Array>), progress),
                { 'content-type': contentType },
                {
                    maxFileBytes: maxBytes,
                    deferBytes: DEFER_BYTES,
                    imageBufferCap: THUMBNAIL_MAX_BYTES,
                    maxFieldBytes: MAX_FIELD_BYTES,
                    onFileStart: (info) => validateFileStart(info.filename, info.mimeType),
                    openSink: (info, before): UploadSink<SinkResult> => {
                        streamStart = Date.now();
                        if (backend === 'reactor') {
                            // Fields sent after the file are unknown here: sample only if the client declared up front
                            // that the upload is neither client-encrypted nor password-protected.
                            const sink = openStorePutStream({ contentType: info.mimeType || 'application/octet-stream', noSample: !mayStreamSample(before) });
                            return {
                                write: (c) => sink.write(c),
                                end: async () => ({ kind: 'reactor', put: await sink.end() }),
                                abort: (r) => sink.abort(r),
                            };
                        }
                        return openTempFileSink(shareID, tempFiles);
                    },
                },
            );
        } catch (err) {
            if (err instanceof UploadTooLargeError) return tooLarge(maxBytes);
            if (err instanceof MultipartError) {
                return NextResponse.json({ success: false, message: err.message, code: err.code }, { status: 400 });
            }
            const mapped = storeErrorResponse(err);
            if (mapped) return mapped;
            throw err;
        }

        progress?.processing();
        const { fields } = parsed;
        const file = parsed.file;
        if (file?.sinkResult?.kind === 'reactor') {
            // Committed (pinned) in the store: from here on any failure must unpin it.
            storedObjects.push(toReactorStoragePath(file.sinkResult.put.file_id));
        }
        if (!file) {
            return NextResponse.json({
                success: false,
                message: 'No file provided',
                code: 'NO_FILE'
            }, { status: 400 });
        }

        const password = typeof fields.password === 'string' ? fields.password : null;
        const tagsRaw = typeof fields.tags === 'string' ? fields.tags : null;
        const summary = typeof fields.summary === 'string' ? fields.summary.slice(0, 2000) : null;
        const isEncrypted = fields.is_encrypted === 'true' ? 1 : 0;
        const ivEntry = fields.iv;
        // DCE2 (chunked streaming E2E format) carries its nonces in the ciphertext header; the record only stores the
        // format marker in encryption_iv (a v1 IV is 16 base64url chars, so the marker never collides).
        const isDce2 = isEncrypted === 1 && fields.encryption_format === DCE2_FORMAT_FIELD;
        const encryptionIv = isDce2
            ? DCE2_DB_MARKER
            : typeof ivEntry === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(ivEntry) && ivEntry !== DCE2_DB_MARKER ? ivEntry : null;

        const tagsArray = parseTags(tagsRaw);
        // Deterministic HMAC tag over the sorted tag list (used for exact-match similarity).
        const similarityToken = FHELight.generateSimilarityToken(tagsArray);

        let passwordHash: string | null = null;
        if (password && password.trim().length > 0) {
            if (password.length > 1024) throw new ValidationError('Password too long', 'INVALID_PASSWORD');
            passwordHash = await hashPassword(password);
        }

        // Validate file size (empty file etc.); over-limit uploads were already stopped mid-stream.
        if (config.validation.enableSizeCheck) {
            const sizeValidation = validateFileSize(file.size, maxBytes);
            if (!sizeValidation.valid) {
                throw new ValidationError(sizeValidation.error || 'Invalid file size', sizeValidation.code || 'INVALID_SIZE');
            }
        }

        // Display-safe name (metadata only; never used for on-disk paths)
        const sanitizedName = sanitizeFilename(file.filename);
        const originalName = sanitizedName;
        const mimeType = file.mimeType || 'application/octet-stream';
        const sniffedType = sniffFileType(file.head);

        // Hash-chained upload log (SHA-256 computed while streaming) + MIME-type classification (informational only)
        await LedgerService.recordHash(file.sha256, { filename: sanitizedName, size: file.size, uploader: userId || 'anon' });
        await AIService.analyze(file.head, mimeType);

        const requestOrigin = new URL(request.url).origin;

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
            // evolved class recipes, so the legacy /compress path is skipped. Large files were already streamed into
            // the store during parsing; small ones (all form fields now known) are sent here in one request.
            let put: StorePutResult;
            let durationMs: number;
            if (file.sinkResult?.kind === 'reactor') {
                put = file.sinkResult.put;
                durationMs = Date.now() - streamStart;
            } else {
                const buf = file.buffered ?? Buffer.alloc(0);
                const startTime = Date.now();
                try {
                    put = await putStoreFile(new Uint8Array(buf.buffer as ArrayBuffer, buf.byteOffset, buf.byteLength), {
                        contentType: mimeType,
                        noSample,
                    });
                } catch (err) {
                    const mapped = storeErrorResponse(err);
                    if (mapped) return mapped;
                    throw err;
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
            const tempPath = file.sinkResult?.kind === 'temp' ? file.sinkResult.path : null;
            if (!compress && tempPath && !storageProvider.isExternal()) {
                // Uncompressed local object streamed to a temp file: move it into place without buffering.
                finalStoragePath = await moveIntoLocalStorage(tempPath, shareID);
                storedObjects.push(finalStoragePath);
            } else {
                // Compression (reactor /compress or TS fallback) and S3 uploads take a buffer, as before.
                const buffer = tempPath ? await fs.promises.readFile(tempPath) : (file.buffered ?? Buffer.alloc(0));
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

        console.log(`[INGEST] Saving ${shareID} to database...`);
        await FileRepository.create({
            share_id: shareID,
            user_id: userId || null,
            original_name: originalName,
            sanitized_name: sanitizedName,
            storage_path: finalStoragePath,
            thumbnail_path: finalThumbPath,
            password_hash: passwordHash,
            is_external: isExternal,
            file_size: file.size,
            mime_type: mimeType,
            expires_at: Date.now() + SHARE_TTL_MS,
            compression_ratio: ratio, // display label: compression and dedup reported separately (formatStoreRatio)
            compression_speed: speed,
            tags: tagsRaw,
            summary: summary,
            is_encrypted: isEncrypted,
            encryption_iv: encryptionIv,
            similarity_token: similarityToken
        });
        storedObjects.length = 0; // committed

        if (reactorClass || reactorRecipe) {
            // Best effort: informational metadata only; older databases may lack these columns.
            await FileRepository.setReactorMeta(shareID, reactorClass, reactorRecipe);
        }

        await AuditLogger.record({
            userId: userId,
            action: 'FILE_UPLOAD',
            resource: shareID,
            details: `${engine === 'reactor_store' ? 'Reactor store' : compress ? 'Compressed' : 'Uncompressed'} upload (${file.size} bytes). Storage: ${ratio}. Client-encrypted: ${isEncrypted === 1}`,
            ipAddress: getClientIdentifier(request)
        });

        if (compress) {
            await WebhookService.dispatch('file.uploaded', {
                shareId: shareID,
                ownerId: userId,
                filename: originalName,
                size: file.size,
                encrypted: isEncrypted === 1
            });
        }

        return NextResponse.json({
            success: true,
            link: getShareLinkUrl(shareID, requestOrigin),
            stats: {
                speed,
                ratio, // display label, e.g. "2.50x compressed" or "~1.80x compressed · 40% dedup"
                engine,
                compression: compressionFactor, // logical / stored bytes of newly written data (null: nothing new written)
                compressionEstimated,
                dedupPercent, // % of chunks already stored (reactor store only)
            }
        });
    } catch (e: unknown) {
        // Roll back any objects written before the failure
        for (const loc of storedObjects) {
            try { await removeStoredObject(loc, storageProvider.isExternal()); } catch { /* ignore */ }
        }

        const mapped = storeErrorResponse(e);
        if (mapped) return mapped;

        if (e instanceof ValidationError) {
            return NextResponse.json({
                success: false,
                message: e.message,
                code: e.code
            }, { status: e.statusCode });
        }

        const err = e instanceof Error ? e : new Error(String(e));
        const errorLog = `\n[${new Date().toISOString()}] FATAL INGEST ERROR: ${err.message}\n${err.stack}\n`;
        try {
            fs.mkdirSync(path.dirname(config.debug.debugLogPath), { recursive: true });
            fs.appendFileSync(config.debug.debugLogPath, errorLog);
        } catch { /* ignore */ }
        console.error('[INGEST] Fatal ingestion error:', err.message);

        return NextResponse.json({
            success: false,
            message: 'Internal server error',
            code: 'INTERNAL_ERROR'
        }, { status: 500 });
    } finally {
        for (const tmp of tempFiles) fs.promises.rm(tmp, { force: true }).catch(() => { });
    }
}
