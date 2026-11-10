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

  const { fileId, email } = body;
  if (!fileId || !email) {
    return NextResponse.json({ error: 'fileId and email are required' }, { status: 400 });
  }

  try {
    await DeliveryService.sendOtp(fileId, email);
    return NextResponse.json({ success: true, message: 'Verification code sent to your email' });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to send verification code' }, { status: 400 });
  }
}

export const POST = withObservability(handlePOST, '/api/transfers/otp/send');
