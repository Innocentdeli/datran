import { test, expect, makeFile, chooseFiles, startUpload, waitForShareLink, uploadHeading, throttleUploads, uploadPercent } from '../fixtures';

test.describe('landing upload card', () => {
    test('idle state', async ({ page }) => {
        await page.goto('/');
        await expect(page.getByRole('heading', { level: 1 })).toContainText('Send big files.');
        await expect(uploadHeading(page)).toHaveText('Send files');
        await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
        await expect(page.getByText(/or choose them from your device · up to .+ per file/)).toBeVisible();
        await expect(page.locator('section[aria-labelledby="upload-heading"]').getByText('End-to-end encrypted')).toBeVisible();
        // Nothing selected yet: no upload action.
        await expect(page.getByRole('button', { name: 'Upload & get link' })).toHaveCount(0);
    });

    test('small file: select, upload, share link, copy, QR', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        const file = await makeFile('hello-e2e.txt', 48 * 1024);
        await page.goto('/');
        await chooseFiles(page, [file]);
        await expect(uploadHeading(page)).toHaveText('1 file selected');
        await expect(page.getByRole('list', { name: 'Selected files' })).toContainText(file.name);
        await expect(page.getByText('1 file · 48 KB')).toBeVisible();

        await startUpload(page);
        const link = await waitForShareLink(page);
        expect(new URL(link).origin).toBe(new URL(page.url()).origin);

        await page.getByRole('button', { name: 'Copy link' }).click();
        await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

        const qr = page.getByRole('img', { name: 'QR code of the share link' });
        await expect(qr).toBeVisible();
        expect(await qr.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
        await expect(page.getByRole('link', { name: 'Open' })).toHaveAttribute('href', link);
    });

    test('~50 MB file: progress is visible until the link appears', async ({ page }) => {
        test.slow();
        const file = await makeFile('big-50mb.bin', 50 * 1024 * 1024);
        await page.goto('/');
        await throttleUploads(page, 12 * 1024 * 1024);
        await chooseFiles(page, [file]);
        await startUpload(page);

        await expect(uploadHeading(page)).toHaveText('Uploading…');
        const bar = page.getByRole('progressbar', { name: 'Upload progress' });
        await expect(bar).toBeVisible();
        await expect(page.getByText(/of 50(\.0)? MB/)).toBeVisible();
        // Progress moves through intermediate values, with a measured speed.
        await expect.poll(() => uploadPercent(page), { timeout: 60_000 }).toBeGreaterThan(10);
        const mid = await uploadPercent(page);
        expect(mid).toBeLessThan(100);
        await expect(page.getByText(/Speed: \d/)).toBeVisible({ timeout: 30_000 });

        const link = await waitForShareLink(page, 180_000);
        expect(link).toContain('#key=');
        await expect(page.getByRole('list', { name: 'Share links' })).toContainText(file.name);
    });
});
