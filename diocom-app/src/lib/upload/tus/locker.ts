import { randomBytes } from 'crypto';
import type { KV, Unsubscribe } from '../../kv/types';

/**
 * Per-upload lock on the shared KV (Redis SET NX PX + compare-and-delete, renewed while held), so two requests for
 * the same upload can never write it concurrently, even on different instances.
 *
 * Takeover: after a network drop the client resumes while the server may still be blocked reading the dead request.
 * A waiter that may take over publishes a release request on `tus:release:<id>`; the holder, if it is only
 * receiving bytes (`releasable`), stops reading, persists its offset and releases. Finalization is never interrupted.
 */

export class LockLostError extends Error {
    constructor(id: string) {
        super(`upload lock for ${id} was lost`);
        this.name = 'LockLostError';
    }
}

export class ReleaseRequestedError extends Error {
    constructor() {
        super('another request for this upload took over');
        this.name = 'ReleaseRequestedError';
    }
}

export interface HeldLock {
    /** Aborted when a takeover is requested while `releasable`, or when the lease is lost. */
    readonly signal: AbortSignal;
    /** True once the lease could not be renewed: the holder must stop and must NOT write the record any more. */
    readonly lost: boolean;
    /** Whether a release request interrupts the holder (true while receiving bytes, false while finalizing). */
    releasable: boolean;
    release(): Promise<void>;
}

export interface AcquireOptions {
    /** How long to wait for the lock (0: one attempt). */
    waitMs: number;
    /** Ask the current holder to let go (resuming clients). */
    requestRelease: boolean;
}

export interface TusLocker {
    acquire(id: string, opts: AcquireOptions): Promise<HeldLock | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class KvLocker implements TusLocker {
    constructor(private readonly kv: KV, private readonly ttlMs = 30_000) { }

    async acquire(id: string, opts: AcquireOptions): Promise<HeldLock | null> {
        const key = `lock:tus:${id}`;
        const channel = `tus:release:${id}`;
        const token = `${process.pid}:${randomBytes(12).toString('base64url')}`;
        const deadline = Date.now() + Math.max(0, opts.waitMs);
        let lastRequest = 0;
        let delay = 50;
        for (; ;) {
            if (await this.kv.setNX(key, token, this.ttlMs)) break;
            const now = Date.now();
            if (now >= deadline) return null;
            if (opts.requestRelease && now - lastRequest >= 1000) {
                lastRequest = now;
                await this.kv.publish(channel, token).catch(() => undefined);
            }
            await sleep(Math.min(delay, Math.max(1, deadline - now)));
            delay = Math.min(delay * 2, 250);
        }

        const ac = new AbortController();
        let lost = false;
        let released = false;
        const held: HeldLock = {
            signal: ac.signal,
            get lost() { return lost; },
            releasable: false,
            release: async () => {
                if (released) return;
                released = true;
                clearInterval(renew);
                await unsubscribe?.().catch(() => undefined);
                if (!lost) await this.kv.delIfEquals(key, token).catch(() => false);
            },
        };
        const renew = setInterval(() => {
            this.kv.pexpireIfEquals(key, token, this.ttlMs).then(
                (ok) => { if (!ok && !released) { lost = true; ac.abort(new LockLostError(id)); } },
                () => { /* transient KV error: retry on the next tick; the lease is ttlMs long */ },
            );
        }, Math.max(100, Math.floor(this.ttlMs / 3)));
        (renew as { unref?: () => void }).unref?.();
        let unsubscribe: Unsubscribe | null = null;
        try {
            unsubscribe = await this.kv.subscribe(channel, (msg) => {
                if (msg !== token && held.releasable && !released) ac.abort(new ReleaseRequestedError());
            });
        } catch {
            unsubscribe = null; // takeover then only happens after the request times out
        }
        return held;
    }
}
