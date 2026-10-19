import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import pretty from 'pino-pretty';
import { trace, isSpanContextValid } from '@opentelemetry/api';
import { hostname } from 'os';
import { CENSOR, REDACT_PATHS, sanitizeHeaders, sanitizeUrl, scrubString, serializeError } from './redact';
import { getRequestContext } from './context';

/**
 * Structured server-side logging (pino).
 *
 *   LOG_LEVEL   trace|debug|info|warn|error|fatal|silent (default: info in production, debug otherwise)
 *   LOG_FORMAT  json|pretty (default: json in production, pretty otherwise)
 *
 * Every line carries service/instance, and inside a route wrapped with withObservability() also requestId, route,
 * method and (once authenticated) userId; with OpenTelemetry active, trace_id/span_id. Secrets are redacted (see
 * ./redact.ts). Server code only: never import this from client components.
 *
 * Usage in a module:
 *   const log = createModuleLogger('cleanup');
 *   log.info({ deleted }, 'cleanup complete');
 *   log.error({ err }, 'purge failed');
 */

const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']);

export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): string {
    const v = (env.LOG_LEVEL || '').trim().toLowerCase();
    if (LEVELS.has(v)) return v;
    return env.NODE_ENV === 'production' ? 'info' : 'debug';
}

export function buildLoggerOptions(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
    return {
        level: resolveLogLevel(env),
        base: {
            service: env.OTEL_SERVICE_NAME || 'diocom-app',
            instance: env.HOSTNAME && env.HOSTNAME !== '0.0.0.0' ? env.HOSTNAME : safeHostname(),
            pid: process.pid,
        },
        timestamp: pino.stdTimeFunctions.isoTime,
        messageKey: 'msg',
        formatters: { level: (label) => ({ level: label }) },
        redact: { paths: REDACT_PATHS, censor: CENSOR },
        serializers: {
            err: serializeError,
            error: serializeError,
            url: sanitizeUrl,
            headers: sanitizeHeaders,
        },
        hooks: {
            // Scrub free-text arguments (message + printf args) for URL credentials, tokens, fragments, IPs.
            logMethod(args, method) {
                const a0 = args[0] as unknown;
                if (a0 instanceof Error) (args as unknown[])[0] = { err: a0 };
                // pino copies err.message into msg when no message is given; supply a scrubbed one instead.
                const first = args[0] as unknown;
                if (first && typeof first === 'object' && (first as { err?: unknown }).err instanceof Error && typeof args[1] !== 'string') {
                    (args as unknown[]).splice(1, 0, ((first as { err: Error }).err.message || 'error'));
                }
                for (let i = 0; i < args.length; i++) {
                    const a = args[i];
                    if (typeof a === 'string') (args as unknown[])[i] = scrubString(a);
                }
                return method.apply(this, args as Parameters<typeof method>);
            },
        },
        mixin() {
            const span = trace.getActiveSpan();
            if (!span) return {};
            const sc = span.spanContext();
            return isSpanContextValid(sc) ? { trace_id: sc.traceId, span_id: sc.spanId } : {};
        },
    };
}

function safeHostname(): string {
    try {
        return hostname();
    } catch {
        return 'unknown';
    }
}

/** Creates a logger. `destination` is for tests (capture output); production writes JSON to stdout. */
export function createLogger(opts: { env?: NodeJS.ProcessEnv; destination?: DestinationStream } = {}): Logger {
    const env = opts.env ?? process.env;
    const options = buildLoggerOptions(env);
    if (opts.destination) return pino(options, opts.destination);
    const format = (env.LOG_FORMAT || '').toLowerCase() || (env.NODE_ENV === 'production' ? 'json' : 'pretty');
    if (format === 'pretty') {
        try {
            return pino(options, pretty({ colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,service,instance' }));
        } catch {
            // fall through to JSON
        }
    }
    return pino(options);
}

const g = globalThis as typeof globalThis & { __diocomLogger?: Logger };

/** Process-wide root logger (shared by all route bundles via globalThis). */
export function rootLogger(): Logger {
    return g.__diocomLogger ?? (g.__diocomLogger = createLogger());
}

/** Test hook. */
export function setRootLoggerForTesting(l: Logger | undefined): void {
    g.__diocomLogger = l;
}

/** The current request's logger (requestId/route/method/userId bound) or the root logger outside a request. */
export function getLogger(): Logger {
    return getRequestContext()?.log ?? rootLogger();
}

type LogFn = {
    (msg: string, ...args: unknown[]): void;
    (obj: object | Error, msg?: string, ...args: unknown[]): void;
};
export interface ModuleLogger {
    trace: LogFn; debug: LogFn; info: LogFn; warn: LogFn; error: LogFn; fatal: LogFn;
}

/**
 * A lightweight logger for a module: resolves the request-scoped logger at call time (so log lines inside a request
 * carry its requestId) and adds `module`. An Error as the first argument is logged as `err`.
 */
export function createModuleLogger(module: string): ModuleLogger {
    const make = (level: keyof ModuleLogger): LogFn =>
        ((first: unknown, ...rest: unknown[]) => {
            const l = getLogger();
            if (!l.isLevelEnabled(level)) return;
            const fn = l[level].bind(l) as (...a: unknown[]) => void;
            if (first instanceof Error) fn({ module, err: first }, ...rest);
            else if (first && typeof first === 'object') fn({ module, ...(first as object) }, ...rest);
            else fn({ module }, first, ...rest);
        }) as LogFn;
    return { trace: make('trace'), debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error'), fatal: make('fatal') };
}
