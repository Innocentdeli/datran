import { FileRepository } from '@/db/files';
import { removeStoredObject } from '@/lib/storage';
import { forgetFile, runPredictionRetention } from '@/lib/prefetcher';

let running = false;

/**
 * Deletes expired files: stored object (local or S3), thumbnail, then the DB record.
 * Also enforces access-event retention for the prediction model (PREDICT_RETENTION_DAYS).
 * Scheduled from src/instrumentation.ts (CLEANUP_INTERVAL_MS).
 */
export async function runCleanupJob() {
    if (running) return; // don't overlap runs
    running = true;
    try {
        await runPredictionRetention();
        const expiredFiles = await FileRepository.findExpired();
        if (expiredFiles.length === 0) return;

        console.log(`[CLEANUP] Found ${expiredFiles.length} expired files. Purging...`);
        let deletedCount = 0;
        let errorCount = 0;

        for (const file of expiredFiles) {
            try {
                const external = Number(file.is_external) === 1;
                await removeStoredObject(file.storage_path, external);
                await removeStoredObject(file.thumbnail_path, external);
                await FileRepository.delete(file.id);
                forgetFile(file.share_id);
                deletedCount++;
            } catch (e) {
                console.error(`[CLEANUP] Failed to purge ${file.id}:`, e instanceof Error ? e.message : e);
                errorCount++;
            }
        }

        console.log(`[CLEANUP] Complete. Deleted: ${deletedCount}, Errors: ${errorCount}`);
    } catch (e) {
        console.error('[CLEANUP] Critical error during cleanup:', e instanceof Error ? e.message : e);
    } finally {
        running = false;
    }
}
