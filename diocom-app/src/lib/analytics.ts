import db from '@/db';
import { randomUUID } from 'crypto';
import { createModuleLogger } from './observability/logger';

const log = createModuleLogger('analytics');

export interface AnalyticsEvent {
    fileId: string;
    eventType: 'view' | 'download' | 'upload_complete';
    ipAddress?: string;
    userAgent?: string;
}

export const AnalyticsService = {
    record: async (event: AnalyticsEvent) => {
        try {
            const id = randomUUID();
            const timestamp = Date.now();

            await db.query(`
                INSERT INTO analytics (id, file_id, event_type, timestamp, ip_address, user_agent)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [id, event.fileId, event.eventType, timestamp, event.ipAddress || null, event.userAgent || null]);

            // Also update main counters for quick access
            if (event.eventType === 'download') {
                await db.query('UPDATE files SET downloads = downloads + 1, last_accessed_at = $1 WHERE id = $2', [timestamp, event.fileId]);
            } else if (event.eventType === 'view') {
                await db.query('UPDATE files SET last_accessed_at = $1 WHERE id = $2', [timestamp, event.fileId]);
            }

        } catch (e) {
            log.error({ err: e }, 'failed to record event');
        }
    },

    getStats: async () => {
        // Total bandwidth (approx), total downloads, etc.
        const totalFilesRes = await db.query('SELECT COUNT(*) as count FROM files');
        const totalDownloadsRes = await db.query('SELECT SUM(downloads) as count FROM files');
        const totalSizeRes = await db.query('SELECT SUM(file_size) as size FROM files');

        // Recent activity
        const recentEventsRes = await db.query(`
            SELECT a.*, f.original_name 
            FROM analytics a 
            LEFT JOIN files f ON a.file_id = f.id 
            ORDER BY timestamp DESC 
            LIMIT 50
        `);

        return {
            totalFiles: parseInt(totalFilesRes.rows[0]?.count || '0'),
            totalDownloads: parseInt(totalDownloadsRes.rows[0]?.count || '0'),
            totalStorage: parseInt(totalSizeRes.rows[0]?.size || '0'),
            recentEvents: recentEventsRes.rows
        };
    }
};
