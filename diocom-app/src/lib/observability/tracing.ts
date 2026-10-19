import { context, propagation } from '@opentelemetry/api';

/**
 * OpenTelemetry tracing (registered from src/instrumentation.ts).
 *
 *   OTEL_EXPORTER_OTLP_ENDPOINT (or OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) set -> @vercel/otel exports spans over OTLP
 *     (OTEL_EXPORTER_OTLP_PROTOCOL / OTEL_EXPORTER_OTLP_HEADERS honoured). Next.js emits its own route/render spans.
 *   unset -> nothing is registered; the @opentelemetry/api calls below are no-ops.
 *   OTEL_SERVICE_NAME (default "diocom-app").
 *
 * W3C traceparent is propagated to the reactor: by the fetch instrumentation for every URL under REACTOR_URL, and
 * explicitly via traceHeaders() in reactorHeaders() for callers that build their own requests.
 */

export function tracingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return !!(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT);
}

export async function registerTracing(reactorUrl: string): Promise<boolean> {
    if (!tracingEnabled()) return false;
    const { registerOTel } = await import('@vercel/otel');
    registerOTel({
        serviceName: process.env.OTEL_SERVICE_NAME || 'diocom-app',
        instrumentationConfig: {
            fetch: { propagateContextUrls: [reactorUrl] },
        },
    });
    return true;
}

/** Adds `traceparent` (+ `tracestate`/baggage) for the active span to `headers`. No-op without a registered SDK. */
export function traceHeaders(headers: Record<string, string> = {}): Record<string, string> {
    try {
        propagation.inject(context.active(), headers);
    } catch {
        /* ignore */
    }
    return headers;
}
