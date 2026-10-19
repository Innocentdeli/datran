import { NextResponse } from 'next/server';
import { requireRequestUser } from '@/lib/auth/requestUser';
import { FileRepository } from '@/db/files';
import { getShareLinkUrl } from '@/config';
import { withObservability } from '@/lib/observability';

export const dynamic = 'force-dynamic';

/** GET /api/mobile/files: the signed-in user's uploads (public fields only, toPublicFile) with their share links. */
async function handleGET(req: Request) {
    const user = await requireRequestUser(req);
    if (user instanceof NextResponse) return user;
    const limit = Math.min(500, Number(new URL(req.url).searchParams.get('limit')) || 100);
    const origin = new URL(req.url).origin;
    const files = (await FileRepository.listPublicByUser(user.id, limit)).map((f) => ({ ...f, link: getShareLinkUrl(f.share_id, origin) }));
    return NextResponse.json({ success: true, files }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withObservability(handleGET, '/api/mobile/files');
