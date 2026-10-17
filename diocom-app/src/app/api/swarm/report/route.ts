import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '../../../api/auth/[...nextauth]/route';
import { SovereignCredit } from '@/lib/SovereignCredit';
import { AuditLogger } from '@/lib/AuditLogger';
import { enforceRateLimit } from '@/lib/rateLimit';

/**
 * Swarm Report API
 *
 * Transfer reports are self-reported by the client and therefore NOT trustworthy.
 * Credit minting is disabled unless SWARM_CREDITS_ENABLED === 'true', and even then
 * every user is hard-capped per day (SWARM_DAILY_CREDIT_CAP, default 1.0 $DTN).
 * A real implementation needs 2-party (seeder + receiver) signed receipts.
 */

const BYTES_PER_CREDIT = 1024 * 1024 * 1024; // 1 $DTN per GB
const MAX_REPORT_BYTES = 10 * BYTES_PER_CREDIT;

type DailyEntry = { day: string; earned: number };
const g = globalThis as unknown as { __diocomSwarmDaily?: Map<string, DailyEntry> };
const daily: Map<string, DailyEntry> = g.__diocomSwarmDaily ?? (g.__diocomSwarmDaily = new Map());

function dailyCap(): number {
    const v = parseFloat(process.env.SWARM_DAILY_CREDIT_CAP || '1');
    return Number.isFinite(v) && v >= 0 ? v : 1;
}

export async function POST(request: Request) {
    const session = await getServerSession(authOptions);
    const userId = (session?.user as { id?: string } | undefined)?.id;
    if (!userId) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const limited = enforceRateLimit(request, 'swarm-report', { maxRequests: 30, windowMs: 60_000 }, userId);
    if (limited) return limited;

    try {
        const { peerId, fileId, bytesSent, status } = await request.json();

        if (process.env.SWARM_CREDITS_ENABLED !== 'true') {
            return NextResponse.json({ success: true, earned: 0, message: 'Report received. Credit rewards are disabled.' });
        }

        const bytes = Number(bytesSent);
        if (status !== 'complete' || !Number.isFinite(bytes) || bytes <= 0 || typeof fileId !== 'string') {
            return NextResponse.json({ success: true, earned: 0, message: 'Report received. No credits earned.' });
        }

        const day = new Date().toISOString().slice(0, 10);
        const entry = daily.get(userId);
        const earnedToday = entry && entry.day === day ? entry.earned : 0;
        const remaining = Math.max(0, dailyCap() - earnedToday);

        const claimed = Math.min(bytes, MAX_REPORT_BYTES) / BYTES_PER_CREDIT;
        const amount = parseFloat(Math.min(claimed, remaining).toFixed(4));

        if (amount <= 0) {
            return NextResponse.json({ success: true, earned: 0, message: 'Daily reward cap reached.' });
        }

        daily.set(userId, { day, earned: earnedToday + amount });

        await SovereignCredit.earn(userId, amount, `Seeded file: ${String(fileId).slice(0, 64)}`);
        await AuditLogger.record({
            userId,
            action: 'SWARM_REWARD',
            resource: String(fileId).slice(0, 64),
            details: `Earned ${amount} $DTN (self-reported ${bytes} bytes to ${String(peerId).slice(0, 64)}; capped)`,
        });

        return NextResponse.json({
            success: true,
            earned: amount,
            newBalance: await SovereignCredit.getBalance(userId),
        });
    } catch (error) {
        console.error('[swarm/report]', error);
        return NextResponse.json({ error: 'Failed to process report' }, { status: 500 });
    }
}
