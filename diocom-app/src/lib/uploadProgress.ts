import { Transform } from 'stream';
import { getKV, type KV, type Unsubscribe } from './kv';

/**
 * Upload progress over the shared KV, so the upload POST (/api/ingest) and the SSE subscriber (/api/progress)
 * may be served by different instances.
 *
 *  - The client picks a random upload id (16-64 chars of [A-Za-z0-9_-]) and sends it as `x-upload-id` (or
 *    `?uploadId=`) on the POST, and opens GET /api/progress?uploadId=<id> (alias `fileId`).
 *  - The ingest route counts request-body bytes and publishes throttled events on channel `progress:<id>`; the
 *    latest event is also stored (`progress:last:<id>`, short TTL) so a subscriber that connects late, or on
 *    another instance, starts from the current state.
 *  - Events carry only byte counts and a phase, never the share id or file name; the id is an unguessable
 *    client secret.
 */

export const UPLOAD_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const LAST_TTL_MS = 10 * 60_000;
const THROTTLE_MS = 250;

export type ProgressPhase = 'uploading' | 'processing' | 'done' | 'error';

export interface ProgressEvent {
    uploadId: string;
    phase: ProgressPhase;
    received: number;
    total: number | null;
    percent: number | null;
    message?: string;
    at: number;
}

const channel = (id: string) => `progress:${id}`;
const lastKey = (id: string) => `progress:last:${id}`;

export function isValidUploadId(id: unknown): id is string {
    return typeof id === 'string' && UPLOAD_ID_RE.test(id);
}

export async function publishProgress(ev: ProgressEvent, kv: KV = getKV()): Promise<void> {
    const json = JSON.stringify(ev);
    await kv.set(lastKey(ev.uploadId), json, LAST_TTL_MS);
    await kv.publish(channel(ev.uploadId), json);
}

export async function lastProgress(uploadId: string, kv: KV = getKV()): Promise<ProgressEvent | null> {
    const raw = await kv.get(lastKey(uploadId));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as ProgressEvent;
    } catch {
        return null;
    }
}

export function subscribeProgress(uploadId: string, handler: (ev: ProgressEvent) => void, kv: KV = getKV()): Promise<Unsubscribe> {
    return kv.subscribe(channel(uploadId), (raw) => {
        try {
            handler(JSON.parse(raw) as ProgressEvent);
        } catch { /* ignore malformed */ }
    });
}

export interface ProgressReporter {
    /** Pass-through stream that counts bytes and publishes throttled 'uploading' events. */
    counter(): Transform;
    processing(): void;
    done(): Promise<void>;
    fail(message: string): Promise<void>;
}

/** Reporter for one upload. Publishing is best-effort: KV errors are logged, never fail the upload. */
export function createProgressReporter(uploadId: string, total: number | null, kv: KV = getKV()): ProgressReporter {
    let received = 0;
    let lastSent = 0;
    let finished = false;
    const percent = () => (total && total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null);
    // Serialized so a slow 'uploading' write can never land after (and overwrite) the final 'done'/'error'.
    let chain: Promise<void> = Promise.resolve();
    const send = (phase: ProgressPhase, message?: string) => {
        const ev: ProgressEvent = { uploadId, phase, received, total, percent: phase === 'done' ? 100 : percent(), message, at: Date.now() };
        chain = chain
            .then(() => publishProgress(ev, kv))
            .catch((e) => console.warn('[progress] publish failed:', e instanceof Error ? e.message : e));
        return chain;
    };

    return {
        counter() {
            return new Transform({
                transform(chunk: Buffer, _enc, cb) {
                    received += chunk.length;
                    const now = Date.now();
                    if (!finished && now - lastSent >= THROTTLE_MS) {
                        lastSent = now;
                        void send('uploading');
                    }
                    cb(null, chunk);
                },
            });
        },
        processing() {
            if (!finished) void send('processing');
        },
        async done() {
            if (finished) return;
            finished = true;
            await send('done');
        },
        async fail(message: string) {
            if (finished) return;
            finished = true;
            await send('error', message.slice(0, 200));
        },
    };
}
