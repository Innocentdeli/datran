import type { Page, Request } from '@playwright/test';
import {
    test, expect, makeFile, chooseFiles, startUpload, waitForShareLink, uploadHeading, throttleUploads, uploadPercent,
    openAsRecipient, downloadAndHash, appAlerts,
} from '../fixtures';

const MB = 1024 * 1024;

/** Records the tus traffic and any single-request fallback (/api/ingest) of a page. */
function watchUploads(page: Page) {
    const tus: Request[] = [];
    const ingest: Request[] = [];
    const heads: Array<{ url: string; offset: number; length: number }> = [];
    page.on('request', (r) => {
        const p = new URL(r.url()).pathname;
        if (p.startsWith('/api/uploads')) tus.push(r);
        if (p === '/api/ingest') ingest.push(r);
    });
    page.on('response', (res) => {
        const r = res.request();
        if (r.method() === 'HEAD' && new URL(r.url()).pathname.startsWith('/api/uploads/')) {
            heads.push({ url: r.url(), offset: Number(res.headers()['upload-offset'] ?? -1), length: Number(res.headers()['upload-length'] ?? -1) });
        }
    });
    const patchOffsets = () => tus.filter((r) => r.method() === 'PATCH').map((r) => Number(r.headers()['upload-offset'] ?? -1));
    return { tus, ingest, heads, patchOffsets };
}

test.describe('resumable uploads', () => {
    test.slow();

    test('network drop mid-upload: retries and resumes from the server offset', async ({ page, newRecipientContext }, testInfo) => {
        const file = await makeFile('resume-offline.bin', 48 * MB);
        const w = watchUploads(page);
        await page.goto('/');
        const network = await throttleUploads(page, 6 * MB);
        await chooseFiles(page, [file]);
        await startUpload(page);
        await expect.poll(() => uploadPercent(page), { timeout: 60_000 }).toBeGreaterThan(15);

        // Offline emulation does not cut a request already in flight, so stay offline until the next tus request
        // has actually failed, then a little longer (the browser reports navigator.onLine === false meanwhile).
        await network.setOffline(true);
        await page.waitForEvent('requestfailed', { predicate: (r) => new URL(r.url()).pathname.startsWith('/api/uploads'), timeout: 90_000 });
        await page.waitForTimeout(3_000);
        // Still uploading (retrying with backoff): not failed, not restarted as a single request.
        await expect(uploadHeading(page)).toHaveText('Uploading…');
        expect(w.ingest).toHaveLength(0);
        await network.setOffline(false);

        const link = await waitForShareLink(page, 180_000);
        // After the drop the upload continued from a non-zero offset (HEAD -> PATCH at the server's offset)...
        expect(Math.max(...w.heads.map((h) => h.offset))).toBeGreaterThan(0);
        expect(Math.max(...w.patchOffsets())).toBeGreaterThan(0);
        // ...and never restarted as a single non-resumable request.
        expect(w.ingest).toHaveLength(0);
        expect(w.tus.filter((r) => r.method() === 'POST')).toHaveLength(1);

        // The resumed ciphertext decrypts to the original bytes.
        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        const dl = await downloadAndHash(viewer, testInfo.outputPath());
        expect(dl.sha256).toBe(file.sha256);
    });

    test('reload mid-upload, select the same file again: resumes at the stored offset', async ({ page, newRecipientContext }, testInfo) => {
        const file = await makeFile('resume-reload.bin', 40 * MB);
        page.on('dialog', (d) => void d.accept()); // "Leave site?" (beforeunload while uploading)
        await page.goto('/');
        await throttleUploads(page, 6 * MB);
        await chooseFiles(page, [file]);
        await startUpload(page);
        await expect.poll(() => uploadPercent(page), { timeout: 60_000 }).toBeGreaterThan(30);

        await page.reload();
        const w = watchUploads(page);
        await expect(uploadHeading(page)).toHaveText('Send files');
        await chooseFiles(page, [file]);
        await startUpload(page);
        const link = await waitForShareLink(page, 180_000);

        // The re-selected file resumed the earlier tus upload (HEAD showed bytes already on the server) instead of
        // creating a new one.
        expect(w.heads.length).toBeGreaterThan(0);
        expect(w.heads[0].offset).toBeGreaterThan(0);
        expect(w.heads[0].offset).toBeLessThan(w.heads[0].length);
        expect(w.tus.filter((r) => r.method() === 'POST')).toHaveLength(0);
        expect(w.ingest).toHaveLength(0);

        // Same link key recovered from the vault: the recipient gets the original bytes.
        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        const dl = await downloadAndHash(viewer, testInfo.outputPath());
        expect(dl.sha256).toBe(file.sha256);
    });

    test('pause stops the transfer, resume continues it', async ({ page, newRecipientContext }, testInfo) => {
        const file = await makeFile('pause-resume.bin', 32 * MB);
        const w = watchUploads(page);
        await page.goto('/');
        await throttleUploads(page, 5 * MB);
        await chooseFiles(page, [file]);
        await startUpload(page);
        await expect.poll(() => uploadPercent(page), { timeout: 60_000 }).toBeGreaterThan(20);

        await page.getByRole('button', { name: 'Pause' }).click();
        await expect(uploadHeading(page)).toHaveText('Paused');
        await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
        const pausedAt = await uploadPercent(page);
        const requestsAtPause = w.tus.length;
        await page.waitForTimeout(2_000);
        // Nothing is sent while paused and progress is kept.
        expect(w.tus.length).toBe(requestsAtPause);
        expect(await uploadPercent(page)).toBe(pausedAt);
        expect(w.ingest).toHaveLength(0);

        await page.getByRole('button', { name: 'Resume' }).click();
        const link = await waitForShareLink(page, 180_000);
        const resumedHead = w.heads.at(-1);
        expect(resumedHead?.offset).toBeGreaterThan(0);
        expect(w.tus.filter((r) => r.method() === 'POST')).toHaveLength(1);
        expect(w.ingest).toHaveLength(0);

        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        const dl = await downloadAndHash(viewer, testInfo.outputPath());
        expect(dl.sha256).toBe(file.sha256);
    });

    test('cancel aborts the upload, discards it on the server and skips the single-request fallback', async ({ page }) => {
        const file = await makeFile('cancel-me.bin', 32 * MB);
        const w = watchUploads(page);
        await page.goto('/');
        await throttleUploads(page, 4 * MB);
        await chooseFiles(page, [file]);
        await startUpload(page);
        await expect.poll(() => uploadPercent(page), { timeout: 60_000 }).toBeGreaterThan(5);

        await page.getByRole('button', { name: 'Cancel' }).click();
        // Back to the selection, file still listed, nothing failed.
        await expect(uploadHeading(page)).toHaveText('1 file selected');
        await expect(page.getByRole('button', { name: 'Upload & get link' })).toBeVisible();
        await expect(appAlerts(page)).toHaveCount(0);
        // The unfinished tus upload is terminated (DELETE) and no /api/ingest fallback ran.
        await expect.poll(() => w.tus.filter((r) => r.method() === 'DELETE').length).toBeGreaterThan(0);
        const deleted = w.tus.find((r) => r.method() === 'DELETE')!;
        const after = await page.request.fetch(deleted.url(), { method: 'HEAD', headers: { 'Tus-Resumable': '1.0.0' } });
        expect([404, 410]).toContain(after.status());
        await page.waitForTimeout(1_500);
        expect(w.ingest).toHaveLength(0);
        // Local resume state is gone too: the next upload starts fresh.
        const resumeKeys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('diocom_tus_dce2:') || k.startsWith('tus::')));
        expect(resumeKeys).toEqual([]);
    });
});
