import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../auth/[...nextauth]/route';
import { SovereignCredit } from '@/lib/SovereignCredit';

export async function GET() {
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
        console.error('[v1/user/credits]', error);
        return NextResponse.json({ error: 'Failed to load balance' }, { status: 500 });
    }
}
