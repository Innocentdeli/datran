import { handleTusRequest } from '@/lib/upload/tusApp';
import { withObservability } from '@/lib/observability/withObservability';

/**
 * tus 1.0.0 resumable uploads: creation endpoint (POST, OPTIONS). Upload URLs: /api/uploads/<id>.
 * Protocol: src/lib/upload/tus/protocol.ts; app wiring and metadata keys: src/lib/upload/tusApp.ts.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const handler = withObservability(handleTusRequest, '/api/uploads');

export const POST = handler;
export const OPTIONS = handler;
