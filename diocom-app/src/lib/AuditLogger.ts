import * as crypto from 'crypto';
import db from '@/db';
import { createModuleLogger } from './observability/logger';

const auditLog = createModuleLogger('audit');

/**
 * AuditLogger
 * 
 * Provides an immutable, hash-chained ledger for administrative and security auditing.
 * Each log entry contains a hash of itself and the previous entry, ensuring integrity.
 */
export class AuditLogger {
    /**
     * Records a new audit event.
     */
    public static async record({
        userId,
        action,
        resource,
        details,
        ipAddress
    }: {
        userId?: string;
        action: string;
        resource: string;
        details?: string;
        ipAddress?: string;
    }) {
        const timestamp = Date.now();
        const id = crypto.randomUUID();

        // 1. Get the hash of the most recent log entry to chain them
        const lastLogRes = await db.query('SELECT hash FROM audit_logs ORDER BY timestamp DESC LIMIT 1');
        const lastLog = lastLogRes.rows[0];
        const previousHash = lastLog ? lastLog.hash : '0000000000000000000000000000000000000000000000000000000000000000';

        // 2. Generate hash for the current entry (Id + Action + Resource + Timestamp + Details + IP + PrevHash)
        const hashPayload = `${id}|${action}|${resource}|${timestamp}|${details || ''}|${ipAddress || ''}|${previousHash}`;
        const hash = crypto.createHash('sha256').update(hashPayload).digest('hex');

        // 3. Persist to DB
        try {
            await db.query(`
                INSERT INTO audit_logs (id, user_id, action, resource, details, ip_address, timestamp, previous_hash, hash)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            `, [id, userId || null, action, resource, details || null, ipAddress || null, timestamp, previousHash, hash]);
            
            auditLog.info({ action, resource, auditId: id }, 'audit record written');
        } catch (error) {
            auditLog.error({ err: error }, 'failed to record audit log');
        }
    }

    /**
     * Verifies the integrity of the audit trail.
     */
    public static async verifyChain(): Promise<boolean> {
        const res = await db.query('SELECT * FROM audit_logs ORDER BY timestamp ASC');
        const logs = res.rows;
        let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';

        for (const log of logs) {
            // Verify previous hash link
            if (log.previous_hash !== expectedPrevHash) {
                auditLog.error({ auditId: log.id, expectedPrevHash, previousHash: log.previous_hash }, 'audit chain broken');
                return false;
            }

            // Verify current hash
            const hashPayload = `${log.id}|${log.action}|${log.resource}|${log.timestamp}|${log.details || ''}|${log.ip_address || ''}|${log.previous_hash}`;
            const hash = crypto.createHash('sha256').update(hashPayload).digest('hex');
            
            if (log.hash !== hash) {
                auditLog.error({ auditId: log.id }, 'audit integrity violation: hash mismatch');
                return false;
            }

            expectedPrevHash = log.hash;
        }

        return true;
    }
}
