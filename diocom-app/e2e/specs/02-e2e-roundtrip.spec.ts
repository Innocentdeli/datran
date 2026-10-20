import { createHash } from 'node:crypto';
import { test, expect, makeFile, uploadViaLanding, openAsRecipient, downloadAndHash, shareIdOf } from '../fixtures';

test.describe('end-to-end encryption round trip', () => {
    test('recipient in a new context decrypts via the service worker; bytes match', async ({ page, request, newRecipientContext }, testInfo) => {
        test.slow();
        // > 1 MiB: resumable tus path with on-the-fly DCE2 encryption.
        const file = await makeFile('quarterly-report.bin', 3 * 1024 * 1024 + 12_345);
        const link = await uploadViaLanding(page, [file]);
        const shareId = shareIdOf(link);

        // The server only ever sees ciphertext: different bytes, larger (header + per-chunk tags), key not sent.
        const raw = await request.get(`/api/stream?file=${encodeURIComponent(shareId)}`);
        expect(raw.ok()).toBeTruthy();
        const cipher = await raw.body();
        expect(cipher.length).toBeGreaterThan(file.size);
        expect(createHash('sha256').update(cipher).digest('hex')).not.toBe(file.sha256);

        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        await expect(viewer.getByRole('heading', { name: file.name })).toBeVisible();
        await expect(viewer.getByRole('list', { name: 'File details' })).toContainText('End-to-end encrypted');

        const dl = await downloadAndHash(viewer, testInfo.outputPath());
        expect(dl.name).toBe(file.name);
        expect(dl.size).toBe(file.size);
        expect(dl.sha256).toBe(file.sha256);
        // The decrypting worker controls the viewer.
        expect(await viewer.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? null)).toMatch(/\/e2e-sw\.js$/);
    });

    test('small file (single request) round trip', async ({ page, newRecipientContext }, testInfo) => {
        const file = await makeFile('note.bin', 200 * 1024 + 7);
        const link = await uploadViaLanding(page, [file]);
        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        const dl = await downloadAndHash(viewer, testInfo.outputPath());
        expect(dl.sha256).toBe(file.sha256);
    });

    test('tampered link key shows a clear decryption error; missing key is explained', async ({ page, newRecipientContext }) => {
        const file = await makeFile('tamper-me.bin', 256 * 1024);
        const link = await uploadViaLanding(page, [file]);
        const [base, key] = link.split('#key=');
        // Same length/alphabet, different key.
        const i = Math.floor(key.length / 2);
        const tampered = `${base}#key=${key.slice(0, i)}${key[i] === 'A' ? 'B' : 'A'}${key.slice(i + 1)}`;

        const { page: viewer } = await openAsRecipient(newRecipientContext, tampered);
        await expect(viewer.getByRole('heading', { name: file.name })).toBeVisible();
        const download = viewer.waitForEvent('download', { timeout: 15_000 }).catch(() => null);
        await viewer.getByRole('button', { name: /^Download/ }).click();
        await expect(viewer.getByRole('alert').filter({ hasText: /Decryption failed/ })).toBeVisible({ timeout: 30_000 });
        await expect(viewer.getByRole('alert').filter({ hasText: /Decryption failed/ })).toContainText(/wrong|tampered/);
        // If the browser started a download at all, it must not complete with (wrong) data.
        const d = await download;
        if (d) expect(await d.failure()).not.toBeNull();

        const { page: noKey } = await openAsRecipient(newRecipientContext, base);
        await noKey.getByRole('button', { name: /^Download/ }).click();
        await expect(noKey.getByRole('alert').filter({ hasText: /missing its #key/ })).toBeVisible();
    });
});
