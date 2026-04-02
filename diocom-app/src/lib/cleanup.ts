import { FileRepository } from '@/db/files';
import fs from 'fs';
import { config } from '@/config';

export async function runCleanupJob() {
    console.log('[CLEANUP] Starting file expiration check...');

    try {
        const expiredFiles = await FileRepository.findExpired();

        if (expiredFiles.length === 0) {
            console.log('[CLEANUP] No expired files found.');
            return;
        }

        console.log(`[CLEANUP] Found ${expiredFiles.length} expired files. Purging...`);

        let deletedCount = 0;
        let errorCount = 0;

        for (const file of expiredFiles) {
            try {
                // 1. Delete physical file
                if (fs.existsSync(file.storage_path)) {
                    fs.unlinkSync(file.storage_path);
                }

                // 2. Delete DB record
                await FileRepository.delete(file.id);

                console.log(`[CLEANUP] Purged: ${file.original_name} (${file.share_id})`);
                deletedCount++;
            } catch (e) {
                console.error(`[CLEANUP] Failed to purge ${file.id}:`, e);
                errorCount++;
            }
        }

        console.log(`[CLEANUP] Complete. Deleted: ${deletedCount}, Errors: ${errorCount}`);
    } catch (e) {
        console.error('[CLEANUP] Critical error during cleanup:', e);
    }
}
