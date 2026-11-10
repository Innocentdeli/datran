import { NextResponse } from 'next/server';
import { DeliveryService } from '@/lib/transfers/deliveryService';
import { withObservability } from '@/lib/observability';

async function handlePOST(request: Request) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON payload' }, { status: 400 });
  }

  const { fileId, token, event } = body;

  if (!fileId || !token || (event !== 'open' && event !== 'download')) {
    return NextResponse.json({ error: 'Valid fileId, token, and event (open|download) required' }, { status: 400 });
  }

  const tracked = await DeliveryService.trackEvent(fileId, token, event);
  return NextResponse.json({ success: tracked });
}

export const POST = withObservability(handlePOST, '/api/transfers/track');
