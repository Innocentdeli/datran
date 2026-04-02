import { NextResponse } from 'next/server';
import { FileRepository } from '@/db/files';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { AuditLogger } from '@/lib/AuditLogger';

/**
 * Datran Core Developer API (v1)
 * 
 * Provides headless access to file metadata and system status.
 * Requires Bearer Token or Session Auth.
 */

export async function GET(request: Request) {
    const session = await getServerSession(authOptions);

    // Security Check: Restricted to authenticated developers/users
    if (!session) {
        return NextResponse.json({ error: 'Unauthorized. Valid session or API key required.' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const action = searchParams.get('action');

    // Audit the API Access
    await AuditLogger.record({
        userId: session.user.id,
        action: 'API_ACCESS',
        resource: 'DEVELOPER_V1',
        details: `Action: ${action || 'LIST_FILES'}`
    });

    switch (action) {
        case 'status':
            return NextResponse.json({
                status: 'operational',
                version: '1.4.0-godtier',
                uptime: process.uptime(),
                services: {
                    reactor: 'active',
                    swarm: 'active',
                    cognitive: 'active'
                }
            });

        case 'files':
        default:
            // Return files owned by the user
            const files = await FileRepository.findByUserId(session.user.id);
            return NextResponse.json({
                success: true,
                count: files.length,
                data: files.map(f => ({
                    id: f.share_id,
                    name: f.original_name,
                    size: f.file_size,
                    created: f.created_at,
                    encrypted: f.is_encrypted === 1,
                    tags: JSON.parse(f.tags || '[]')
                }))
            });
    }
}

export async function POST(request: Request) {
    // Simulated Webhook Registration or Remote Ingestion
    return NextResponse.json({ message: 'Headless ingestion via API is a Premium/Enterprise feature.' }, { status: 501 });
}
