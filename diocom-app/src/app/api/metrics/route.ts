import { createHash, timingSafeEqual } from 'crypto';
import { getMetrics, withObservability } from '@/lib/observability';

export const dynamic = 'force-dynamic';

/**
 * Prometheus scrape endpoint for THIS instance (each app instance is scraped separately).
 *   METRICS_TOKEN unset -> 404 (disabled).
 *   Otherwise requires `Authorization: Bearer <METRICS_TOKEN>` (401 without / with a wrong token).
 * The edge proxy (deploy/caddy/app.caddy) additionally refuses /api/metrics from the internet.
 */
function tokenMatches(header: string | null, expected: string): boolean {
    const m = /^Bearer\s+(.+)$/i.exec(header || '');
    if (!m) return false;
    const a = createHash('sha256').update(m[1].trim()).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

async function handleGET(request: Request) {
    const expected = process.env.METRICS_TOKEN;
    if (!expected) return new Response('Not Found', { status: 404 });
    if (!tokenMatches(request.headers.get('authorization'), expected)) {
        return new Response('Unauthorized', {
            status: 401,
            headers: { 'WWW-Authenticate': 'Bearer realm="metrics"', 'Cache-Control': 'no-store' },
        });
    }
    const { registry } = getMetrics();
    return new Response(await registry.metrics(), {
        status: 200,
        headers: { 'Content-Type': registry.contentType, 'Cache-Control': 'no-store' },
    });
}

export const GET = withObservability(handleGET, '/api/metrics', { quiet: true });
