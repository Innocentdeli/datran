import { withObservability } from '@/lib/observability';
import { checkReadiness } from '@/lib/observability/readiness';

export const dynamic = 'force-dynamic';

/**
 * Readiness: 200 when the database is reachable and migrated, Redis is reachable (if REDIS_URL is set) and the
 * reactor answers (if STORAGE_BACKEND=reactor); 503 with per-check details otherwise.
 */
async function handleGET() {
    const report = await checkReadiness();
    return Response.json(
        { status: report.status, checks: report.checks },
        { status: report.httpStatus, headers: { 'Cache-Control': 'no-store' } },
    );
}

export const GET = withObservability(handleGET, '/api/health/ready', { quiet: true });
