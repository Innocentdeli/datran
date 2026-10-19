import { NextResponse } from 'next/server';
import { handleStripeWebhook } from '@/lib/billing/webhook';
import { withObservability } from '@/lib/observability';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/billing/webhook: Stripe events. The signature is verified over the RAW request bytes, so the body is
 * read as an ArrayBuffer (never parsed/re-serialised). Logic: src/lib/billing/webhook.ts.
 */
async function handlePOST(req: Request) {
    const raw = Buffer.from(await req.arrayBuffer());
    const result = await handleStripeWebhook(raw, req.headers.get('stripe-signature'));
    return NextResponse.json(result.body, { status: result.status, headers: { 'Cache-Control': 'no-store' } });
}

export const POST = withObservability(handlePOST, '/api/billing/webhook');
