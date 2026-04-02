
import { NextResponse } from 'next/server';
import fs from 'fs';
import { config } from '@/config';
import { FileRepository } from '@/db/files';
import { cookies } from 'next/headers';
import '@/db/schema';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const fileId = searchParams.get('file');

    if (!fileId) {
        return new NextResponse("File not specified", { status: 400 });
    }

    console.log(`[STREAM] Request for: ${fileId}`);

    // 1. Database Lookup
    // We assume fileId is the share_id (e.g., 'filename.omni.acs')
    const fileRecord = await FileRepository.findByShareId(fileId);

    if (!fileRecord) {
        console.error(`[STREAM] File not found in registry: ${fileId}`);
        return new NextResponse("File not found in registry", { status: 404 });
    }

    console.log(`[STREAM] Found record. Path: ${fileRecord.storage_path}`);

    // 2. Expiration Check
    if (fileRecord.expires_at && Date.now() > fileRecord.expires_at) {
        return new NextResponse("File has expired", { status: 410 });
    }

    // 3. Password Protection Check
    if (fileRecord.password_hash) {
        const cookieStore = await cookies();
        const hasAccess = cookieStore.get(`diocom_access_${fileRecord.share_id}`);
        if (!hasAccess) {
            return new NextResponse("Access Denied: Password Required", { status: 403 });
        }
    }

    // 4. Update Analytics (Last Accessed)
    await FileRepository.incrementDownloads(fileRecord.share_id);

    // 5. CDN Redirect
    if (fileRecord.is_external === 1) {
        return NextResponse.redirect(fileRecord.storage_path);
    }

    const filePath = fileRecord.storage_path;
    const exists = fs.existsSync(filePath);

    if (!exists) {
        return new NextResponse("File content missing from disk", { status: 404 });
    }

    const fileSize = fileRecord.file_size; // Use DB size
    const range = request.headers.get('range');
    const contentType = fileRecord.mime_type || 'application/octet-stream';

    if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

        // Safety check for range
        if (start >= fileSize) {
            return new NextResponse("Requested range not satisfiable", { status: 416 });
        }

        const chunksize = (end - start) + 1;
        const nodeStream = fs.createReadStream(filePath, { start, end });
        const webStream = new ReadableStream({
            start(controller) {
                nodeStream.on('data', (chunk) => controller.enqueue(chunk));
                nodeStream.on('end', () => controller.close());
                nodeStream.on('error', (err) => controller.error(err));
            },
            cancel() {
                nodeStream.destroy();
            },
        });

        const headers = {
            'Content-Range': `bytes ${start}-${end}/${fileSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize.toString(),
            'Content-Type': contentType,
        };

        return new NextResponse(webStream, { status: 206, headers });
    } else {
        const headers = {
            'Content-Length': fileSize.toString(),
            'Content-Type': contentType,
        };
        const nodeStream = fs.createReadStream(filePath);
        console.log(`[STREAM] Initiating NodeReadStream for: ${filePath}`);

        const webStream = new ReadableStream({
            start(controller) {
                nodeStream.on('data', (chunk) => {
                    // console.log(`[STREAM] Enqueueing chunk: ${chunk.length} bytes`);
                    controller.enqueue(chunk);
                });
                nodeStream.on('end', () => {
                    console.log(`[STREAM] NodeStream finished: ${fileId}`);
                    controller.close();
                });
                nodeStream.on('error', (err) => {
                    console.error(`[STREAM] NodeStream error: ${err.message}`);
                    controller.error(err);
                });
            },
            cancel() {
                console.log(`[STREAM] WebStream cancelled by client`);
                nodeStream.destroy();
            },
        });

        return new NextResponse(webStream, { status: 200, headers });
    }
}
