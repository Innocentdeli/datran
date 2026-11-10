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

  const { fileId, recipients, senderEmail, senderName, customMessage, requireOtp, keyFragment } = body;

  if (!fileId || typeof fileId !== 'string') {
    return NextResponse.json({ error: 'fileId is required' }, { status: 400 });
  }

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return NextResponse.json({ error: 'At least one recipient email is required' }, { status: 400 });
  }

  try {
    const origin = new URL(request.url).origin;
    const result = await DeliveryService.sendTransferByEmail({
      fileId,
      recipients,
      senderEmail,
      senderName,
      customMessage,
      requireOtp: !!requireOtp,
      origin,
      keyFragment,
    });

    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to dispatch email transfer' }, { status: 500 });
  }
}

export const POST = withObservability(handlePOST, '/api/transfers/send-email');
