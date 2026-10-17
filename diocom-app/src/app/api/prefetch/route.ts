import { NextResponse } from 'next/server';
import { enforceRateLimit } from '@/lib/rateLimit';
import { warmIntent } from '@/lib/prefetcher';

/**
 * Viewer "intent" hint (DownloadViewer / VideoPlayer call this when a file page opens): the file's stream request is
 * likely imminent, so its decoded bytes are warmed into the stream cache (NETWORK_SPEC §5). Only bytes are warmed;
 * /api/stream still enforces expiry and password/access checks on every serve, and nothing is returned here.
 * Deleted, expired, external and uncompressed files are skipped by the warmer.
 */
export async function POST(request: Request) {
    try {
        const limited = enforceRateLimit(request, 'prefetch', { maxRequests: 30, windowMs: 60_000 });
        if (limited) return limited;

        const body = await request.json().catch(() => null);
        const fileId = body && typeof body === 'object' ? (body as { fileId?: unknown }).fileId : undefined;
        if (typeof fileId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(fileId)) {
            return NextResponse.json({ success: false }, { status: 400 });
        }

        // Same response whether or not the file exists: this endpoint must not be an existence oracle.
        const queued = warmIntent(fileId);
        return NextResponse.json({ success: true, queued }, { status: 202 });
    } catch (e) {
        console.error('[prefetch]', e);
        return NextResponse.json({ success: false }, { status: 500 });
    }
}
