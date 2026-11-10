import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { ApiKeyService } from '@/lib/auth/apiKeyService';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const keys = await ApiKeyService.listApiKeys(session.user.id);
    return NextResponse.json({ success: true, keys });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to list keys' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { name } = body;
    if (!name || !name.trim()) {
      return NextResponse.json({ error: 'Key name is required' }, { status: 400 });
    }

    const key = await ApiKeyService.createApiKey(session.user.id, name);
    return NextResponse.json({ success: true, ...key });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to generate key' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const keyId = searchParams.get('id');
    if (!keyId) {
      return NextResponse.json({ error: 'Key ID is required' }, { status: 400 });
    }

    await ApiKeyService.deleteApiKey(session.user.id, keyId);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error)?.message || 'Failed to delete key' }, { status: 500 });
  }
}
