import { NextResponse } from 'next/server';
import { SwarmNodeRepository } from '@/db/files';
import { headers } from 'next/headers';

export async function POST(request: Request) {
    try {
        const { nodeId, region } = await request.json();
        const headerList = await headers();
        const ip = headerList.get('x-forwarded-for') || '127.0.0.1';

        if (!nodeId) return NextResponse.json({ success: false }, { status: 400 });

        await SwarmNodeRepository.pulse(nodeId, region || 'unknown', ip);

        const activeNodes = await SwarmNodeRepository.getActive();
        return NextResponse.json({
            success: true,
            activeNodes: activeNodes.length
        });
    } catch (error) {
        return NextResponse.json({ success: false }, { status: 500 });
    }
}
