import { AsyncLocalStorage } from 'async_hooks';
import type { Logger } from 'pino';

/**
 * Request-scoped context (AsyncLocalStorage), set by withObservability(). Kept on globalThis: route handlers and
 * instrumentation are separate bundles in one process and must share one storage.
 */
export interface RequestContext {
    requestId: string;
    /** Route template, e.g. "/api/inbox/[id]" (never the raw URL). */
    route: string;
    method: string;
    userId?: string;
    log: Logger;
}

const g = globalThis as typeof globalThis & { __diocomRequestAls?: AsyncLocalStorage<RequestContext> };

export function requestStorage(): AsyncLocalStorage<RequestContext> {
    return g.__diocomRequestAls ?? (g.__diocomRequestAls = new AsyncLocalStorage<RequestContext>());
}

export function getRequestContext(): RequestContext | undefined {
    return requestStorage().getStore();
}

/** Current request id (for error bodies, outgoing calls), or undefined outside a request. */
export function currentRequestId(): string | undefined {
    return getRequestContext()?.requestId;
}

/**
 * Binds the authenticated user id to the current request's logger (no-op outside a request). Called from the
 * NextAuth session/jwt callbacks, so every route that resolves a session gets it for free.
 */
export function setRequestUser(userId: string | null | undefined): void {
    const ctx = getRequestContext();
    if (!ctx || !userId || ctx.userId === userId) return;
    const id = String(userId).slice(0, 128);
    ctx.userId = id;
    ctx.log = ctx.log.child({ userId: id });
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** Accepts a client/proxy supplied X-Request-Id only if it is a short, safe token; otherwise null. */
export function acceptRequestId(v: string | null | undefined): string | null {
    if (!v) return null;
    const s = v.trim();
    return REQUEST_ID_RE.test(s) ? s : null;
}
