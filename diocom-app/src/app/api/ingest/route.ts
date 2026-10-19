import { NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { Readable } from 'stream';
import type { ReadableStream as NodeWebReadableStream } from 'stream/web';
import { getClientIdentifier } from '@/lib/rateLimit';
import { getRequestUser, AuthTokenError, authErrorResponse } from '@/lib/auth/requestUser';
import { checkUploadQuota, oversizeError, type UploadAllowance } from '@/lib/billing/enforce';
import { QuotaError, quotaErrorResponse } from '@/lib/billing/errors';
import { getStorageBackend, getStorageRoot } from '@/lib/storage';
import { openStorePutStream } from '@/lib/storage/reactorStore';
import { StorePutResult } from '@/lib/storage/reactorStoreCore';
import {
    parseMultipartUpload,
    ParsedUpload,
    UploadSink,
    UploadTooLargeError,
    MultipartError,
    mayStreamSample,
} from '@/lib/upload/multipartStream';
import {
    getMaxUploadBytes,
    anonymousUploadsAllowed,
    checkUploadRateLimit,
    rateLimitHeaders,
    validateFileStart,
    parseUploadFields,
} from '@/lib/upload/policy';
import {
    finalizeUpload,
    discardContent,
    storeErrorResponse,
    uploadErrorResponse,
    THUMBNAIL_MAX_BYTES,
    type ReceivedFile,
    type StoredContent,
} from '@/lib/upload/finalize';
import { randomToken } from '@/lib/security';
import { createProgressReporter, isValidUploadId, type ProgressReporter } from '@/lib/uploadProgress';
import { withObservability } from '@/lib/observability/withObservability';

/**
 * Single-request multipart upload (web fallback, mobile app, SDK, lobby). Resumable uploads use the tus endpoint
 * /api/uploads; both share the policy (src/lib/upload/policy.ts) and the finalize path (src/lib/upload/finalize.ts).
 */

const MULTIPART_OVERHEAD_BYTES = 1024 * 1024;
/** Files up to this size are held in memory until the whole form is parsed (flags known); larger ones stream. */
const DEFER_BYTES = 8 * 1024 * 1024;
const MAX_FIELD_BYTES = 1024 * 1024;

function countedBody(src: Readable, progress: ProgressReporter | null): Readable {
    if (!progress) return src;
    const counter = progress.counter();
    src.on('error', (e) => counter.destroy(e));
    return src.pipe(counter);
}

type SinkResult = { kind: 'reactor'; put: StorePutResult } | { kind: 'temp'; path: string };

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

/**
 * Optional progress reporting: if the client sends `x-upload-id` (or `?uploadId=`), body bytes are counted and
 * published to the shared KV for GET /api/progress (which may be served by another instance).
 */
export const POST = withObservability(handlePOST, '/api/ingest');

async function handlePOST(request: Request) {
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
    const tempFiles: string[] = [];
    let content: StoredContent | null = null;

    try {
        // Rate limiting (shared budget with tus upload creation)
        const rl = await checkUploadRateLimit(request);
        if (!rl.allowed) {
            return NextResponse.json({
                success: false,
                message: `Rate limit exceeded. Try again in ${rl.retryAfter} seconds.`,
                code: 'RATE_LIMIT_EXCEEDED',
                retryAfter: rl.retryAfter
            }, { status: 429, headers: rateLimitHeaders(rl) });
        }

        // User from the session cookie (web) or a mobile bearer token (needed before buffering for the anonymous gate)
        let userId: string | undefined;
        try {
            userId = (await getRequestUser(request))?.id;
        } catch (e) {
            if (e instanceof AuthTokenError) return authErrorResponse(e);
            throw e;
        }
        if (!userId && !anonymousUploadsAllowed()) {
            return NextResponse.json({ success: false, message: 'Authentication required', code: 'UNAUTHORIZED' }, { status: 401 });
        }

        const contentLength = Number(request.headers.get('content-length'));
        if (!request.headers.get('content-length') || !Number.isFinite(contentLength)) {
            return NextResponse.json({ success: false, message: 'Content-Length required', code: 'LENGTH_REQUIRED' }, { status: 411 });
        }
        // Plan limits (file size, storage, monthly uploads) checked against the declared size before any byte is
        // stored; the resulting byte limit is also enforced while streaming.
        let allowance: UploadAllowance;
        try {
            allowance = await checkUploadQuota({ userId: userId ?? null, size: Math.max(0, contentLength - MULTIPART_OVERHEAD_BYTES) });
        } catch (e) {
            if (e instanceof QuotaError) return quotaErrorResponse(e);
            throw e;
        }
        const maxBytes = Math.min(allowance.maxBytes, getMaxUploadBytes());
        if (contentLength > maxBytes + MULTIPART_OVERHEAD_BYTES) {
            return quotaErrorResponse(oversizeError(allowance, contentLength - MULTIPART_OVERHEAD_BYTES));
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
            if (err instanceof UploadTooLargeError) return quotaErrorResponse(oversizeError(allowance, maxBytes + 1));
            if (err instanceof MultipartError) {
                return NextResponse.json({ success: false, message: err.message, code: err.code }, { status: 400 });
            }
            const mapped = storeErrorResponse(err);
            if (mapped) return mapped;
            throw err;
        }

        progress?.processing();
        const file = parsed.file;
        if (file?.sinkResult) {
            // A reactor put is committed (pinned) in the store: from here on any failure must unpin it.
            content = file.sinkResult.kind === 'reactor'
                ? { kind: 'reactor', put: file.sinkResult.put, durationMs: Date.now() - streamStart }
                : { kind: 'file', path: file.sinkResult.path };
        } else if (file) {
            content = { kind: 'buffer', data: file.buffered ?? Buffer.alloc(0) };
        }
        if (!file || !content) {
            return NextResponse.json({
                success: false,
                message: 'No file provided',
                code: 'NO_FILE'
            }, { status: 400 });
        }

        const meta = await parseUploadFields(parsed.fields);
        const received: ReceivedFile = {
            filename: file.filename,
            mimeType: file.mimeType,
            size: file.size,
            sha256: file.sha256,
            head: file.head,
            imageBuffer: file.imageBuffer,
            content,
        };
        content = null; // finalizeUpload owns the rollback from here on
        const result = await finalizeUpload(received, meta, {
            userId: userId || null,
            requestOrigin: new URL(request.url).origin,
            clientIp: getClientIdentifier(request),
            shareId: shareID,
        });
        return NextResponse.json({ success: true, link: result.link, stats: result.stats });
    } catch (e: unknown) {
        await discardContent(content);
        return uploadErrorResponse(e);
    } finally {
        for (const tmp of tempFiles) fs.promises.rm(tmp, { force: true }).catch(() => { });
    }
}
