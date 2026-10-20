import { test, expect, makeFile, signInViaApi, uploadViaLanding, chooseFiles, startUpload, uploadHeading, appAlerts } from '../fixtures';

// The test server runs with PLAN_FREE_STORAGE_GB=0.001 (~1 MiB of storage on Free; support/environment.mjs).
test('storage quota: the upload over the limit gets the 402 message with an upgrade CTA, without retries', async ({ page, freshAccount }) => {
    await signInViaApi(page.request, freshAccount);
    const first = await makeFile('fits.bin', 300 * 1024);
    const second = await makeFile('too-much.bin', 900 * 1024);

    await page.goto('/');
    await uploadViaLanding(page, [first]);

    const uploadRequests: number[] = [];
    page.on('response', (r) => {
        const p = new URL(r.url()).pathname;
        if ((p === '/api/ingest' || p === '/api/uploads') && r.request().method() === 'POST') uploadRequests.push(r.status());
    });
    await page.getByRole('button', { name: 'Send more files' }).click();
    await chooseFiles(page, [second]);
    await startUpload(page);

    await expect(uploadHeading(page)).toHaveText('Upload failed');
    const alert = appAlerts(page);
    await expect(alert).toContainText(`${second.name} could not be uploaded.`);
    await expect(alert).toContainText('Storage quota exceeded');
    await expect(alert).toContainText('Upgrade to Pro for higher limits.');
    const cta = alert.getByRole('link', { name: 'Upgrade to Pro' });
    await expect(cta).toHaveAttribute('href', '/billing');
    await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();

    // A 402 is final: exactly one request, no client retries.
    await page.waitForTimeout(2_000);
    expect(uploadRequests).toEqual([402]);

    await cta.click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(page.getByRole('progressbar', { name: 'Storage' })).toBeVisible();
});
