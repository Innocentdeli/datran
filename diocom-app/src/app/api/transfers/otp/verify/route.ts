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

  const { fileId, email, code } = body;
  if (!fileId || !email || !code) {
    return NextResponse.json({ error: 'fileId, email, and 6-digit code are required' }, { status: 400 });
  }

  try {
    const outcome = await DeliveryService.verifyOtp(fileId, email, code);
    return NextResponse.json({ success: true, ...outcome });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to verify code' }, { status: 400 });
  }
}

export const POST = withObservability(handlePOST, '/api/transfers/otp/verify');
