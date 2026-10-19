import { NextResponse } from 'next/server';
import fs from 'fs';
import { cookies } from 'next/headers';
import { FileRepository, type FileRecord } from '@/db/files';
import { authorizeEgress, meterBody, settleEgress, type EgressGrant } from '@/lib/billing/enforce';
import { quotaErrorResponse } from '@/lib/billing/errors';
import { hasFileAccess } from '@/lib/crypto/AccessToken';
import { resolveStoredPath } from '@/lib/storage';
import { DictionaryUnavailableError } from '@/lib/reactorWorker';
import { getStreamCache, decodeStoredFile, cacheDecoded, isCompressedRecord, DEMAND_TTL_MS, StoredContentMissingError } from '@/lib/streamCache';
import { recordStreamAccess } from '@/lib/prefetcher';
import { getStoreFile, ReactorStoreUnavailableError } from '@/lib/storage/reactorStore';
import { parseReactorStoragePath, forwardableRange, mapReactorResponse, isCountedAccess } from '@/lib/storage/reactorStoreCore';
import type { CacheOutcome } from '@/lib/predict';
import { createModuleLogger } from '@/lib/observability/logger';
import { observeReactorCall, recordDownload, recordStreamCache } from '@/lib/observability/metrics';
import { withObservability } from '@/lib/observability/withObservability';

const log = createModuleLogger('stream');

// The decompression cache lives in src/lib/streamCache.ts (shared with the prefetcher, NETWORK_SPEC §5).

// ---------------------------------------------------------------------------
// Range parsing (single range only; multi-range is ignored -> full 200)
// ---------------------------------------------------------------------------

type RangeResult =
    | { kind: 'none' }
    | { kind: 'unsatisfiable' }
    | { kind: 'range'; start: number; end: number };

function parseRange(header: string | null, size: number): RangeResult {
    if (!header) return { kind: 'none' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) return { kind: 'none' }; // malformed or multi-range: ignore
    const [, s, e] = m;
    if (!s && !e) return { kind: 'none' };

    if (!s) {
        // suffix range: last N bytes
        const n = parseInt(e, 10);
        if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
        return { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
    }

    const start = parseInt(s, 10);
    let end = e ? parseInt(e, 10) : size - 1;
    if (e && end < start) return { kind: 'none' }; // invalid -> ignore per RFC 9110
    if (start >= size) return { kind: 'unsatisfiable' };
    end = Math.min(end, size - 1);
    return { kind: 'range', start, end };
}

// Content types a browser would execute in our origin; served as downloads instead.
const ACTIVE_TYPES = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/ecmascript|text\/ecmascript)\b/i;

function baseHeaders(contentType: string, isProtected: boolean): Record<string, string> {
    const active = ACTIVE_TYPES.test(contentType);
    const h: Record<string, string> = {
        'Content-Type': active ? 'application/octet-stream' : contentType,
        'Accept-Ranges': 'bytes',
        'X-Content-Type-Options': 'nosniff',
    };
    if (active) h['Content-Disposition'] = 'attachment';
    if (isProtected) h['Cache-Control'] = 'private, no-store';
    return h;
}

function nodeToWebStream(nodeStream: fs.ReadStream): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start(controller) {
            nodeStream.on('data', (chunk) => {
                const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
                if ((controller.desiredSize ?? 1) <= 0) nodeStream.pause();
            });
            nodeStream.on('end', () => controller.close());
            nodeStream.on('error', (err) => controller.error(err));
        },
        pull() {
            nodeStream.resume();
        },
        cancel() {
            nodeStream.destroy();
        },
    });
}

function unsatisfiable(size: number, headers: Record<string, string>) {
    return new NextResponse(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
    });
}

export const GET = withObservability(handleGET, '/api/stream');

async function handleGET(request: Request) {
    const t0 = performance.now();
    const { searchParams } = new URL(request.url);
    const fileId = searchParams.get('file');

    if (!fileId || fileId.length > 512) {
        return new NextResponse('File not specified', { status: 400, headers: { 'Accept-Ranges': 'bytes' } });
    }

    // Works for both new random ids and legacy '<name>.omni.acs' ids (plain DB lookup).
    const fileRecord = await FileRepository.findByShareId(fileId);
    if (!fileRecord) {
        return new NextResponse('File not found', { status: 404, headers: { 'Accept-Ranges': 'bytes' } });
    }

    if (fileRecord.expires_at && Date.now() > Number(fileRecord.expires_at)) {
        return new NextResponse('File has expired', { status: 410, headers: { 'Accept-Ranges': 'bytes' } });
    }

    const isProtected = !!fileRecord.password_hash;
    if (isProtected && !hasFileAccess(await cookies(), fileRecord)) {
        return new NextResponse('Access denied', { status: 403, headers: { 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' } });
    }

    const rangeHeader = request.headers.get('range');
    const contentType = fileRecord.mime_type || 'application/octet-stream';
    const headers = baseHeaders(contentType, isProtected);

    // Plan enforcement: the file OWNER's monthly egress quota pays for this response (credits beyond it, else 402).
    const declared = parseRange(rangeHeader, Number(fileRecord.file_size) || 0);
    const expectedBytes = declared.kind === 'range' ? declared.end - declared.start + 1 : declared.kind === 'none' ? Number(fileRecord.file_size) || 0 : 0;
    const gate = await authorizeEgress({ ownerId: fileRecord.user_id ?? null, shareId: fileRecord.share_id, bytes: expectedBytes });
    if (!gate.ok) return quotaErrorResponse(gate.error);
    const response = await serveFile(request, fileRecord, rangeHeader, headers, t0);
    return meterResponse(response, gate);
}

/** Counts the bytes actually delivered (corrects the egress reservation when the client stops early). */
function meterResponse(res: Response, gate: EgressGrant): Response {
    if ((res.status === 200 || res.status === 206) && res.body) {
        const body = meterBody(res.body, (served) => { void settleEgress(gate, served); });
        return new NextResponse(body, { status: res.status, headers: res.headers });
    }
    // Redirects (external objects) keep the reservation (bytes are served by the CDN on our behalf); errors release it.
    void settleEgress(gate, res.status >= 300 && res.status < 400 ? gate.reserved : 0);
    return res;
}

async function serveFile(request: Request, fileRecord: FileRecord, rangeHeader: string | null, headers: Record<string, string>, t0: number): Promise<Response> {

    // Count a download (and a prediction access event) only for full requests or ranges starting at byte 0,
    // so range continuations (video seeking, resumed downloads) are not double counted.
    const isAccess = (r: RangeResult) => r.kind === 'none' || (r.kind === 'range' && r.start === 0);
    const countDownload = async (r: RangeResult) => {
        if (isAccess(r)) {
            await FileRepository.incrementDownloads(fileRecord.share_id);
        }
    };
    // Called right before a successful response is returned: server-side time to first byte of that response.
    const noteAccess = (r: RangeResult, outcome: CacheOutcome | null) => {
        if (!isAccess(r)) return;
        recordStreamAccess({ request, fileId: fileRecord.share_id, ts: Date.now(), outcome, ttfbMs: performance.now() - t0 });
    };

    // Serves fully decoded bytes from memory (decode cache or a fresh decode), honouring the client's Range.
    const serveDecoded = async (data: Buffer, engine: string, outcome: CacheOutcome) => {
        const size = data.length;
        const r = parseRange(rangeHeader, size);
        headers['X-Datran-Engine'] = engine;

        if (r.kind === 'unsatisfiable') return unsatisfiable(size, headers);
        await countDownload(r);
        noteAccess(r, outcome);
        recordDownload({ source: outcome === 'hit' ? 'memory_cache' : 'decoded', bytes: r.kind === 'range' ? r.end - r.start + 1 : size, counted: isAccess(r) });

        if (r.kind === 'range') {
            const chunk = data.subarray(r.start, r.end + 1);
            return new NextResponse(new Uint8Array(chunk), {
                status: 206,
                headers: {
                    ...headers,
                    'Content-Range': `bytes ${r.start}-${r.end}/${size}`,
                    'Content-Length': chunk.length.toString(),
                },
            });
        }
        return new NextResponse(new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength), {
            status: 200,
            headers: { ...headers, 'Content-Length': size.toString() },
        });
    };

    // Reactor chunked object store (NETWORK_SPEC §2): proxy the client's Range to the reactor and stream its
    // response back. The reactor does range math, 206/416, chunk verification and decoding; the app keeps its own
    // content-type/nosniff/disposition/cache headers and the access/counting rules. Bytes the prefetcher already
    // cached are served from memory.
    const storeId = parseReactorStoragePath(fileRecord.storage_path);
    if (storeId) {
        const cached = getStreamCache().get(fileRecord.share_id, Date.now());
        recordStreamCache(cached ? 'hit' : 'miss');
        if (cached) return serveDecoded(cached.value, `${cached.engine}_cached`, 'hit');

        let upstream: Response;
        try {
            upstream = await observeReactorCall(
                'store_get',
                () => getStoreFile(storeId, { range: forwardableRange(rangeHeader), signal: request.signal }),
                (r) => r.status < 500,
            );
        } catch (err) {
            if (!(err instanceof ReactorStoreUnavailableError)) throw err;
            log.error({ err, fileId: fileRecord.share_id }, 'reactor store unavailable');
            return new NextResponse('Storage temporarily unavailable', {
                status: 503,
                headers: { 'Accept-Ranges': 'bytes', 'Retry-After': '30', 'Cache-Control': 'no-store' },
            });
        }
        const mapped = mapReactorResponse(upstream.status, upstream.headers, { ...headers, 'X-Datran-Engine': 'reactor_store' });
        if (mapped.kind !== 'pass' || mapped.status === 416) {
            await upstream.body?.cancel().catch(() => { });
        }
        if (mapped.kind === 'missing') {
            log.error({ fileId: fileRecord.share_id, storeId }, 'reactor store does not hold the file');
            return new NextResponse('File content missing', { status: 404, headers: { 'Accept-Ranges': 'bytes' } });
        }
        if (mapped.kind === 'error') {
            log.error({ fileId: fileRecord.share_id, upstreamStatus: mapped.upstreamStatus }, 'reactor store GET failed');
            return new NextResponse('Storage temporarily unavailable', {
                status: mapped.upstreamStatus === 503 ? 503 : 502,
                headers: { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' },
            });
        }
        if (mapped.status === 416) return new NextResponse(null, { status: 416, headers: mapped.headers });

        const counted = isCountedAccess(mapped.status, upstream.headers.get('content-range'));
        if (counted) {
            await FileRepository.incrementDownloads(fileRecord.share_id);
            recordStreamAccess({ request, fileId: fileRecord.share_id, ts: Date.now(), outcome: 'miss', ttfbMs: performance.now() - t0 });
        }
        recordDownload({ source: 'reactor_store', bytes: Number(upstream.headers.get('content-length')) || 0, counted });
        return new NextResponse(upstream.body, { status: mapped.status, headers: mapped.headers });
    }

    // External (S3/CDN) objects: redirect.
    if (Number(fileRecord.is_external) === 1) {
        const r = parseRange(rangeHeader, Number(fileRecord.file_size) || 0);
        await countDownload(r);
        noteAccess(r, null);
        recordDownload({ source: 'external', counted: isAccess(r) });
        return NextResponse.redirect(fileRecord.storage_path, { headers: { 'Accept-Ranges': 'bytes' } });
    }

    const filePath = resolveStoredPath(fileRecord.storage_path);
    if (!filePath) {
        log.error({ fileId: fileRecord.share_id }, 'stored path is outside the storage root');
        return new NextResponse('File content missing', { status: 404, headers: { 'Accept-Ranges': 'bytes' } });
    }

    let stat: fs.Stats;
    try {
        stat = await fs.promises.stat(filePath);
    } catch {
        return new NextResponse('File content missing', { status: 404, headers: { 'Accept-Ranges': 'bytes' } });
    }

    if (isCompressedRecord(fileRecord)) {
        let decompressed: Buffer;
        let engine: string;
        const cached = getStreamCache().get(fileRecord.share_id, Date.now());
        const outcome: CacheOutcome = cached ? 'hit' : 'miss';
        recordStreamCache(cached ? 'hit' : 'miss');
        if (cached) {
            decompressed = cached.value;
            engine = `${cached.engine}_cached`;
        } else {
            try {
                const result = await decodeStoredFile(fileRecord);
                decompressed = result.data;
                engine = result.engine;
                cacheDecoded(fileRecord.share_id, result, 'demand', DEMAND_TTL_MS);
            } catch (err) {
                if (err instanceof StoredContentMissingError) {
                    return new NextResponse('File content missing', { status: 404, headers: { 'Accept-Ranges': 'bytes' } });
                }
                if (err instanceof DictionaryUnavailableError || (err instanceof Error && err.name === 'DictionaryUnavailableError')) {
                    // Rust reactor is down (or lacks it too) and the dictionary isn't in REACTOR_STATE_DIR/dicts:
                    // refuse rather than serve garbage. Recoverable once the reactor or the dictionary is back.
                    log.error({ err, fileId: fileRecord.share_id },
                        'cannot decode: start the Rust reactor or make its dictionary available under $REACTOR_STATE_DIR/dicts');
                    return new NextResponse('Decoder temporarily unavailable', {
                        status: 503,
                        headers: { 'Accept-Ranges': 'bytes', 'Retry-After': '30', 'Cache-Control': 'no-store' },
                    });
                }
                log.error({ err, fileId: fileRecord.share_id }, 'decompression failed');
                return new NextResponse('Unable to decode file', { status: 500, headers: { 'Accept-Ranges': 'bytes' } });
            }
        }

        return serveDecoded(decompressed, engine, outcome);
    }

    // Uncompressed: stream from disk using the real on-disk size.
    const size = stat.size;
    const r = parseRange(rangeHeader, size);
    if (r.kind === 'unsatisfiable') return unsatisfiable(size, headers);
    await countDownload(r);
    noteAccess(r, 'disk');
    recordDownload({ source: 'disk', bytes: r.kind === 'range' ? r.end - r.start + 1 : size, counted: isAccess(r) });

    if (r.kind === 'range') {
        const nodeStream = fs.createReadStream(filePath, { start: r.start, end: r.end });
        return new NextResponse(nodeToWebStream(nodeStream), {
            status: 206,
            headers: {
                ...headers,
                'Content-Range': `bytes ${r.start}-${r.end}/${size}`,
                'Content-Length': (r.end - r.start + 1).toString(),
            },
        });
    }

    const nodeStream = fs.createReadStream(filePath);
    return new NextResponse(nodeToWebStream(nodeStream), {
        status: 200,
        headers: { ...headers, 'Content-Length': size.toString() },
    });
}
