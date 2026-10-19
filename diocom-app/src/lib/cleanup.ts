import { FileRepository } from '@/db/files';
import { removeStoredObject } from '@/lib/storage';
import { forgetFile, runPredictionRetention } from '@/lib/prefetcher';

import { withLock, instanceId } from '@/lib/kv';

/** Lease for the cleanup lock; renewed every third of it while the job runs (see withLock). */
const LOCK_TTL_MS = 5 * 60_000;
export const CLEANUP_LOCK = 'cleanup';

/**
 * Deletes expired files: stored object (local or S3), thumbnail, then the DB record.
 * Also enforces access-event retention for the prediction model (PREDICT_RETENTION_DAYS) and deletes expired
 * partial tus uploads from UPLOAD_STAGING_DIR (UPLOAD_EXPIRY_HOURS, see src/lib/upload/tusApp.ts).
 * Scheduled from src/instrumentation.ts (CLEANUP_INTERVAL_MS) on EVERY instance; a distributed lock on the shared
 * KV (Redis SET NX PX, released by compare-and-delete) ensures only one instance runs it at a time — the others
 * skip that round. Without REDIS_URL the lock is per process, which is correct for single-instance deployments.
 * Returns false when skipped because another run holds the lock.
 */
export async function runCleanupJob(): Promise<boolean> {
    let outcome: { acquired: boolean };
    try {
        outcome = await withLock(CLEANUP_LOCK, LOCK_TTL_MS, (signal) => cleanupOnce(signal));
    } catch (e) {
        console.error('[CLEANUP] Could not acquire cleanup lock:', e instanceof Error ? e.message : e);
        return false;
    }
    if (!outcome.acquired) console.log('[CLEANUP] Skipped: another instance holds the cleanup lock.');
    return outcome.acquired;
}

async function cleanupOnce(signal: AbortSignal) {
    console.log(`[CLEANUP] Lock acquired; running on instance ${instanceId()}.`);
    try {
        await runPredictionRetention();
        // Abandoned partial tus uploads (UPLOAD_EXPIRY_HOURS) and orphaned staging files.
        try {
            const { sweepExpiredUploads } = await import('@/lib/upload/tusApp');
            await sweepExpiredUploads();
        } catch (e) {
            console.error('[CLEANUP] Partial-upload sweep failed:', e instanceof Error ? e.message : e);
        }
        const expiredFiles = await FileRepository.findExpired();
        if (expiredFiles.length === 0) return;

        console.log(`[CLEANUP] Found ${expiredFiles.length} expired files. Purging...`);
        let deletedCount = 0;
        let errorCount = 0;

        for (const file of expiredFiles) {
            if (signal.aborted) {
                console.warn('[CLEANUP] Lock lease lost; stopping early (the next holder resumes).');
                break;
            }
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
    }
}
