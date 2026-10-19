import db from '@/db';
import * as crypto from 'crypto';
import { createModuleLogger } from './observability/logger';

const log = createModuleLogger('credits');

/**
 * SovereignCredit
 * 
 * Manages the $DTN Incentivized Swarm economy.
 * Tracks bandwidth contributions (earnings) and priority consumption (spending).
 */
export class SovereignCredit {
    /**
     * Awards credits to a user for seeding/bandwidth contribution.
     */
    public static async earn(userId: string, amount: number, reason: string = 'seeding_contribution') {
        const timestamp = Date.now();
        
        try {
            // Update or Initialize balance using ON CONFLICT
            await db.query(`
                INSERT INTO user_credits (user_id, balance, total_earned, total_spent, last_updated)
                VALUES ($1, $2, $3, 0, $4)
                ON CONFLICT (user_id) DO UPDATE SET 
                    balance = user_credits.balance + EXCLUDED.balance,
                    total_earned = user_credits.total_earned + EXCLUDED.total_earned,
                    last_updated = EXCLUDED.last_updated
            `, [userId, amount, amount, timestamp]);

            // Record in ledger
            await db.query(`
                INSERT INTO credit_ledger (id, user_id, amount, type, reason, timestamp)
                VALUES ($1, $2, $3, 'earn', $4, $5)
            `, [crypto.randomUUID(), userId, amount, reason, timestamp]);

            log.info({ userId, amount, reason }, 'credits awarded');
        } catch (error) {
            log.error({ err: error }, 'failed to award credits');
        }
    }

    /**
     * Deducts credits for priority services or downloads.
     */
    public static async spend(userId: string, amount: number, reason: string): Promise<boolean> {
        const timestamp = Date.now();
        
        try {
            const res = await db.query('SELECT balance FROM user_credits WHERE user_id = $1', [userId]);
            const stats = res.rows[0];
            
            if (!stats || stats.balance < amount) {
                return false; // Insufficient balance
            }

            await db.query(`
                UPDATE user_credits 
                SET balance = balance - $1, 
                    total_spent = total_spent + $2, 
                    last_updated = $3
                WHERE user_id = $4
            `, [amount, amount, timestamp, userId]);

            // Record in ledger
            await db.query(`
                INSERT INTO credit_ledger (id, user_id, amount, type, reason, timestamp)
                VALUES ($1, $2, $3, 'spend', $4, $5)
            `, [crypto.randomUUID(), userId, amount, reason, timestamp]);

            log.info({ userId, amount, reason }, 'credits spent');
            return true;
        } catch (error) {
            log.error({ err: error }, 'failed to spend credits');
            return false;
        }
    }

    /**
     * Gets the current $DTN balance for a user.
     */
    public static async getBalance(userId: string): Promise<number> {
        const res = await db.query('SELECT balance FROM user_credits WHERE user_id = $1', [userId]);
        const stats = res.rows[0];
        return stats ? stats.balance : 0;
    }
}
