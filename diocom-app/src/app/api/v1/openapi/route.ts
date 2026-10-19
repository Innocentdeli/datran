import { NextResponse } from 'next/server';
import { FileRepository } from '@/db/files';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../auth/[...nextauth]/route';
import { AuditLogger } from '@/lib/AuditLogger';
import { withObservability, getLogger } from '@/lib/observability';

/**
 * Datran Core Developer API (v1)
 * 
 * Provides headless access to file metadata and system status.
 * Requires Bearer Token or Session Auth.
 */

function safeTags(raw: unknown): unknown[] {
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || !raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

async function handleGET(request: Request) {
    const session = await getServerSession(authOptions);

    // Security Check: Restricted to authenticated developers/users
    if (!session?.user?.id) {
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
            // Only report what this process actually knows; no synthetic service health
            return NextResponse.json({
                status: 'ok',
                version: process.env.npm_package_version || 'unknown',
                uptime: process.uptime(),
            });

        case 'files':
        default: {
            try {
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
                        tags: safeTags(f.tags)
                    }))
                });
            } catch (e) {
                getLogger().error({ err: e }, 'v1/openapi');
                return NextResponse.json({ error: 'Failed to list files' }, { status: 500 });
            }
        }
    }
}

async function handlePOST() {
    return NextResponse.json({ message: 'Headless ingestion via API is not implemented.' }, { status: 501 });
}

export const GET = withObservability(handleGET, '/api/v1/openapi');
export const POST = withObservability(handlePOST, '/api/v1/openapi');
