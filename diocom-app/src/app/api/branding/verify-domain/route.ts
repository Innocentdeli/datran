import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { BrandingService } from '@/lib/branding/service';

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { domain } = await req.json();
    if (!domain) {
      return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
    }

    const result = await BrandingService.verifyCustomDomain(session.user.id, domain);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Domain verification failed' }, { status: 500 });
  }
}
