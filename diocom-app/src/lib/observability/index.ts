/**
 * Observability entry point for server code (logging, metrics, tracing helpers, route wrapper).
 * Server-only: do not import from client components.
 *
 * Health checks live in ./health (pure logic) and ./readiness (wired to db/kv/reactor); import those directly.
 */
export { createLogger, createModuleLogger, getLogger, rootLogger, type ModuleLogger } from './logger';
export { currentRequestId, getRequestContext, setRequestUser } from './context';
export { withObservability } from './withObservability';
export { traceHeaders } from './tracing';
export {
    getMetrics,
    observeReactorCall,
    recordAuth,
    recordCleanupRun,
    recordDbQuery,
    recordDownload,
    recordKvError,
    recordPrefetchWarm,
    recordRateLimitRejection,
    recordReactorCall,
    recordStreamCache,
    recordUpload,
} from './metrics';
