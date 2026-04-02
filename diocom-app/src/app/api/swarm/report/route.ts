import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]/route';
import { SovereignCredit } from '@/lib/SovereignCredit';
import { AuditLogger } from '@/lib/AuditLogger';

/**
 * Swarm Report API
 * 
 * Securely receive reports of P2P transfers to award $DTN credits.
 * In production, this would require 2-party verification (Seeder + Receiver).
 */
export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const { peerId, fileId, bytesSent, status } = await request.json();

        if (status === 'complete' && bytesSent > 0) {
            // Earning Rate: 1.0 $DTN per 1GB (approx)
            const amount = parseFloat((bytesSent / (1024 * 1024 * 1024)).toFixed(4));
            
            if (amount > 0) {
                await SovereignCredit.earn(
                    session.user.id, 
                    amount, 
                    `Seeded file: ${fileId}`
                );

                // Audit the earning
                await AuditLogger.record({
                    userId: session.user.id,
                    action: 'SWARM_REWARD',
                    resource: fileId,
                    details: `Earned ${amount} $DTN for seeding ${bytesSent} bytes to ${peerId}`
                });

                return NextResponse.json({ 
                    success: true, 
                    earned: amount,
                    newBalance: await SovereignCredit.getBalance(session.user.id)
                });
            }
        }

        return NextResponse.json({ success: true, message: 'Report received. No credits earned.' });
    } catch (error: any) {
        return NextResponse.json({ error: error.message }, { status: 500 });
    }
}
