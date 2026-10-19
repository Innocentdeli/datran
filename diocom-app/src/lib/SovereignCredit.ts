import { createModuleLogger } from './observability/logger';
import { grantCredits, debitCredits, getBalance } from './billing/credits';

const log = createModuleLogger('credits');

/**
 * SovereignCredit
 *
 * Swarm-reward facade over the credit ledger (src/lib/billing/credits.ts): the same balance pays for egress beyond
 * the monthly quota and is topped up by credit-pack purchases. Every change is an atomic, idempotent ledger entry.
 */
export class SovereignCredit {
    /** Awards credits to a user for seeding/bandwidth contribution. */
    public static async earn(userId: string, amount: number, reason: string = 'seeding_contribution', idempotencyKey?: string) {
        try {
            await grantCredits(userId, amount, { type: 'earn', reason, idempotencyKey });
        } catch (error) {
            log.error({ err: error }, 'failed to award credits');
        }
    }

    /** Deducts credits for priority services or downloads. False when the balance is insufficient. */
    public static async spend(userId: string, amount: number, reason: string, idempotencyKey?: string): Promise<boolean> {
        try {
            const r = await debitCredits(userId, amount, { type: 'spend', reason, idempotencyKey });
            return r.ok;
        } catch (error) {
            log.error({ err: error }, 'failed to spend credits');
            return false;
        }
    }

    /** Current balance. */
    public static async getBalance(userId: string): Promise<number> {
        return getBalance(userId);
    }
}
