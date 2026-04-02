import { NextRequest, NextResponse } from 'next/server';
import { EventEmitter } from 'events';

// Global event emitter for progress updates
// In a real production app (serverless/clustered), use Redis Pub/Sub instead
export const progressEmitter = new EventEmitter();
progressEmitter.setMaxListeners(100);

export async function GET(request: NextRequest) {
    const { searchParams } = new URL(request.url);
    const fileId = searchParams.get('fileId');

    if (!fileId) {
        return new NextResponse('Missing fileId', { status: 400 });
    }

    const stream = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder();

            const onProgress = (data: any) => {
                const message = `data: ${JSON.stringify(data)}\n\n`;
                controller.enqueue(encoder.encode(message));
            };

            // Subscribe to specific file ID events
            progressEmitter.on(`progress:${fileId}`, onProgress);

            // Keep connection alive
            const interval = setInterval(() => {
                controller.enqueue(encoder.encode(': keep-alive\n\n'));
            }, 10000);

            request.signal.addEventListener('abort', () => {
                progressEmitter.off(`progress:${fileId}`, onProgress);
                clearInterval(interval);
            });
        }
    });

    return new NextResponse(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        },
    });
}
