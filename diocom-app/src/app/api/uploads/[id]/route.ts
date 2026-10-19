import { handleTusRequest } from '@/lib/upload/tusApp';
import { withObservability } from '@/lib/observability/withObservability';

/**
 * tus 1.0.0 upload resource: HEAD (offset), PATCH (append), DELETE (termination), OPTIONS, POST with
 * X-HTTP-Method-Override, and GET (not tus: the finalize result `{ success, link, stats }` as JSON).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = withObservability(handleTusRequest, '/api/uploads/[id]');

export const HEAD = handler;
export const PATCH = handler;
export const DELETE = handler;
export const GET = handler;
export const POST = handler;
export const OPTIONS = handler;
