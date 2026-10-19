import { checkDatabaseHealth } from '../../db';
import { getKV } from '../kv';
import { getReactorUrl, reactorHeaders } from '../reactorWorker';
import { evaluateReadiness, type ReadinessDeps, type ReadinessReport } from './health';

/** Wires the real dependencies into evaluateReadiness() (see ./health.ts for the rules). */
export function readinessDeps(env: NodeJS.ProcessEnv = process.env): ReadinessDeps {
    const timeoutMs = parseInt(env.HEALTH_TIMEOUT_MS || '', 10) || 2_000;
    const deps: ReadinessDeps = { checkDatabase: checkDatabaseHealth, timeoutMs };
    if (env.REDIS_URL) {
        // A real round trip through the shared KV client (same connection the app uses).
        deps.pingRedis = async () => {
            await getKV().get('health:ping');
        };
    }
    if ((env.STORAGE_BACKEND || '').trim().toLowerCase() === 'reactor') {
        deps.pingReactor = async () => {
            const res = await fetch(`${getReactorUrl()}/health`, {
                headers: reactorHeaders(),
                signal: AbortSignal.timeout(timeoutMs),
                cache: 'no-store',
            });
            await res.body?.cancel().catch(() => undefined);
            if (!res.ok) throw new Error(`reactor /health returned ${res.status}`);
        };
    }
    return deps;
}

export function checkReadiness(): Promise<ReadinessReport> {
    return evaluateReadiness(readinessDeps());
}
