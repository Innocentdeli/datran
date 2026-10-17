import { NextRequest, NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { isValidUploadId, lastProgress, subscribeProgress, type ProgressEvent } from '@/lib/uploadProgress';
import type { Unsubscribe } from '@/lib/kv';

/**
 * SSE upload progress: GET /api/progress?uploadId=<id>  (alias: fileId)
 *
 * Subscribes to the shared KV channel for this upload (Redis pub/sub when REDIS_URL is set), so it works when the
 * upload POST is handled by a different instance. Sends the latest known state first, then live events; closes
 * after 'done'/'error' or MAX_STREAM_MS.
 */

export const dynamic = 'force-dynamic';

const KEEPALIVE_MS = 10_000;
const MAX_STREAM_MS = 30 * 60_000;

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const uploadId = searchParams.get('uploadId') ?? searchParams.get('fileId');
    if (!isValidUploadId(uploadId)) {
        return new NextResponse('Missing or invalid uploadId', { status: 400 });
    }

    const limited = await enforceRateLimit(request, 'progress-sse', { maxRequests: 60, windowMs: 60_000 });
    if (limited) return limited;

    const encoder = new TextEncoder();
    let cleanup: () => void = () => undefined;

    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            let closed = false;
            let unsubscribe: Unsubscribe | null = null;
            let lastAt = 0;
            const timers: ReturnType<typeof setInterval>[] = [];

            const close = () => {
                if (closed) return;
                closed = true;
                timers.forEach((t) => clearInterval(t));
                void unsubscribe?.();
                try {
                    controller.close();
                } catch { /* already closed */ }
            };
            cleanup = close;

            const emit = (ev: ProgressEvent) => {
                if (closed || ev.at < lastAt) return; // drop out-of-order duplicates
                lastAt = ev.at;
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
                } catch {
                    close();
                    return;
                }
                if (ev.phase === 'done' || ev.phase === 'error') close();
            };

            request.signal.addEventListener('abort', close);
            try {
                // Subscribe first, then read the snapshot, so nothing published in between is lost.
                unsubscribe = await subscribeProgress(uploadId, emit);
                if (closed) {
                    void unsubscribe();
                    return;
                }
                const last = await lastProgress(uploadId);
                if (last) emit(last);
            } catch (e) {
                console.error('[progress] subscribe failed:', e instanceof Error ? e.message : e);
                controller.enqueue(encoder.encode(`event: error\ndata: {"message":"progress unavailable"}\n\n`));
                close();
                return;
            }

            timers.push(setInterval(() => {
                if (closed) return;
                try {
                    controller.enqueue(encoder.encode(': keep-alive\n\n'));
                } catch {
                    close();
                }
            }, KEEPALIVE_MS));
            const deadline = setTimeout(close, MAX_STREAM_MS);
            timers.push(deadline as unknown as ReturnType<typeof setInterval>);
        },
        cancel() {
            cleanup();
        },
    });

    return new NextResponse(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    });
}
