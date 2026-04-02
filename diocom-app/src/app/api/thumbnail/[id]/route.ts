import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { FileRepository } from '@/db/files';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';

export async function GET(
    request: Request,
    context: { params: Promise<{ id: string }> }
) {
    const { id } = await context.params;
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return new NextResponse('Unauthorized', { status: 401 });
    }

    // 1. Get file record
    // We assume the ID passed is the share_id or DB ID
    // Let's support share_id for now as it's public-facing ID usually
    let fileRecord = await FileRepository.findByShareId(id);

    // If not found by share_id, try by DB ID
    if (!fileRecord) {
        // Need to add findById to repo if not exists, or just direct query
        // But for now let's rely on share_id which is unique
        return new NextResponse('File not found', { status: 404 });
    }

    // 2. Check ownership (optional? Or strict?)
    // Strict: Only owner can see thumbnail
    if (fileRecord.user_id !== session.user.id) {
        return new NextResponse('Forbidden', { status: 403 });
    }

    if (!fileRecord.thumbnail_path || !fs.existsSync(fileRecord.thumbnail_path)) {
        return new NextResponse('Thumbnail not found', { status: 404 });
    }

    // 3. Serve file
    const fileBuffer = fs.readFileSync(fileRecord.thumbnail_path);

    return new NextResponse(fileBuffer, {
        headers: {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=31536000, immutable',
        },
    });
}
