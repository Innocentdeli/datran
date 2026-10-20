import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { SovereignCredit } from '@/lib/SovereignCredit';
import { withObservability, getLogger } from '@/lib/observability';

async function handleGET() {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    try {
        const balance = await SovereignCredit.getBalance(session.user.id);
        return NextResponse.json({ 
            success: true, 
            balance,
            currency: '$DTN'
        });
    } catch (error) {
        getLogger().error({ err: error }, 'v1/user/credits');
        return NextResponse.json({ error: 'Failed to load balance' }, { status: 500 });
    }
}

export const GET = withObservability(handleGET, '/api/v1/user/credits');
