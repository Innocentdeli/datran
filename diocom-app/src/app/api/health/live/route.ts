import { withObservability } from '@/lib/observability';
import { livenessReport } from '@/lib/observability/health';

export const dynamic = 'force-dynamic';

/** Liveness: the process is up and serving requests. No dependency checks (see /api/health/ready). */
async function handleGET() {
    return Response.json(livenessReport(), { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withObservability(handleGET, '/api/health/live', { quiet: true });
