import { randomUUID } from 'crypto';
import { trace } from '@opentelemetry/api';
import { acceptRequestId, requestStorage, type RequestContext } from './context';
import { rootLogger } from './logger';
import { getMetrics, normalizeMethod, recordHttpRequest } from './metrics';

/**
 * Wraps a Next.js route handler with request id, request-scoped logger, HTTP metrics and span attributes.
 *
 *   async function handleGET(req: Request) { ... }
 *   export const GET = withObservability(handleGET, '/api/inbox/[id]');
 *
 * - X-Request-Id: accepted from the client/proxy when it is a safe token, otherwise generated; echoed on the response.
 * - Logs one line per request (route template, method, status, duration, userId) - never the raw URL, query,
 *   headers, cookies or client IP. `quiet` routes (health, metrics) log at debug.
 * - Unhandled errors: logged with the request id and answered with a generic 500 JSON { error, requestId }.
 *   Next.js control-flow errors (redirect(), notFound(), dynamic-usage bailouts - anything with a `digest`) are
 *   rethrown untouched.
 * - `route` must be the route TEMPLATE (bounded metric label), not the request path.
 */
export interface ObservabilityOptions {
    quiet?: boolean;
}

export function withObservability<Req extends Request, A extends unknown[]>(
    handler: (req: Req, ...args: A) => Response | Promise<Response>,
    route: string,
    opts: ObservabilityOptions = {},
): (req: Req, ...args: A) => Promise<Response> {
    return async (req: Req, ...args: A): Promise<Response> => {
        const t0 = performance.now();
        const requestId = acceptRequestId(req?.headers?.get('x-request-id')) ?? randomUUID();
        const method = normalizeMethod(req?.method);
        const ctx: RequestContext = { requestId, route, method, log: rootLogger().child({ requestId, route, method }) };

        const span = trace.getActiveSpan();
        span?.setAttribute('http.route', route);
        span?.setAttribute('diocom.request_id', requestId);

        const metrics = getMetrics();
        const inFlight = metrics.guards.route.value(route);
        metrics.httpInFlight.inc({ route: inFlight });

        let res: Response;
        try {
            res = await requestStorage().run(ctx, () => handler(req, ...args));
        } catch (err) {
            if (err && typeof err === 'object' && typeof (err as { digest?: unknown }).digest === 'string') {
                metrics.httpInFlight.dec({ route: inFlight });
                throw err;
            }
            ctx.log.error({ err }, 'unhandled error in route handler');
            span?.recordException(err as Error);
            res = new Response(JSON.stringify({ error: 'Internal Server Error', requestId }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            });
        }
        metrics.httpInFlight.dec({ route: inFlight });

        res = withHeader(res, 'X-Request-Id', requestId);
        const seconds = (performance.now() - t0) / 1000;
        recordHttpRequest(route, method, res.status, seconds, metrics);

        // userId (if any) is already bound to ctx.log by setRequestUser().
        const fields = { status: res.status, durationMs: Math.round(seconds * 10_000) / 10 };
        if (res.status >= 500) ctx.log.error(fields, 'request failed');
        else if (opts.quiet) ctx.log.debug(fields, 'request');
        else ctx.log.info(fields, 'request');
        return res;
    };
}

/** Sets a header, copying the response when its headers are immutable (e.g. Response.redirect()). */
function withHeader(res: Response, name: string, value: string): Response {
    try {
        res.headers.set(name, value);
        return res;
    } catch {
        const headers = new Headers(res.headers);
        headers.set(name, value);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
}
