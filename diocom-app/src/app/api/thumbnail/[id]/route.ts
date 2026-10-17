import { NextResponse } from 'next/server';
import fs from 'fs';
import { FileRepository } from '@/db/files';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { resolveStoredPath } from '@/lib/storage';

const MAX_THUMBNAIL_BYTES = 5 * 1024 * 1024;

export async function GET(
    _request: Request,
    context: { params: Promise<{ id: string }> }
) {
    const { id } = await context.params;
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        return new NextResponse('Unauthorized', { status: 401 });
    }

    const fileRecord = await FileRepository.findByShareId(id);

    // Owner-only. Same response for "missing" and "not yours" to avoid enumeration.
    if (!fileRecord || fileRecord.user_id !== session.user.id) {
        return new NextResponse('Not found', { status: 404 });
    }

    if (!fileRecord.thumbnail_path) {
        return new NextResponse('Thumbnail not found', { status: 404 });
    }

    // S3/CDN mode: thumbnails live in the bucket.
    if (/^https?:\/\//i.test(fileRecord.thumbnail_path)) {
        return NextResponse.redirect(fileRecord.thumbnail_path);
    }

    const thumbPath = resolveStoredPath(fileRecord.thumbnail_path);
    if (!thumbPath) {
        return new NextResponse('Thumbnail not found', { status: 404 });
    }

    let fileBuffer: Buffer;
    try {
        const stat = await fs.promises.stat(thumbPath);
        if (!stat.isFile() || stat.size > MAX_THUMBNAIL_BYTES) {
            return new NextResponse('Thumbnail not found', { status: 404 });
        }
        fileBuffer = await fs.promises.readFile(thumbPath);
    } catch {
        return new NextResponse('Thumbnail not found', { status: 404 });
    }

    return new NextResponse(new Uint8Array(fileBuffer.buffer as ArrayBuffer, fileBuffer.byteOffset, fileBuffer.byteLength), {
        headers: {
            'Content-Type': 'image/jpeg',
            'Content-Length': fileBuffer.length.toString(),
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=86400',
        },
    });
}
