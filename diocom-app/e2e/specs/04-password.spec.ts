import { test, expect, makeFile, uploadViaLanding, openAsRecipient, downloadAndHash, shareIdOf, appAlerts } from '../fixtures';

test('password-protected link: wrong password refused, correct one unlocks, download works', async ({ page, request, newRecipientContext }, testInfo) => {
    const password = 'correct horse battery';
    const file = await makeFile('contract.bin', 1536 * 1024);
    const link = await uploadViaLanding(page, [file], { password });
    await expect(page.getByText('Password protected')).toBeVisible();

    // Without the unlock cookie the bytes are not served either.
    const blocked = await request.get(`/api/stream?file=${encodeURIComponent(shareIdOf(link))}`);
    expect([401, 403]).toContain(blocked.status());

    const { page: viewer } = await openAsRecipient(newRecipientContext, link);
    await expect(viewer.getByRole('heading', { name: 'This file is password protected' })).toBeVisible();
    const input = viewer.getByLabel('Password', { exact: true });
    const unlock = viewer.getByRole('button', { name: 'Unlock file' });
    await expect(unlock).toBeDisabled();

    await input.fill('not the password');
    await unlock.click();
    await expect(appAlerts(viewer)).toContainText('That password is not correct');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(viewer.getByRole('heading', { name: file.name })).toHaveCount(0);

    await input.fill(password);
    await unlock.click();
    await expect(viewer.getByRole('heading', { name: file.name })).toBeVisible();
    await expect(viewer.getByRole('list', { name: 'File details' })).toContainText('Password protected');

    const dl = await downloadAndHash(viewer, testInfo.outputPath());
    expect(dl.sha256).toBe(file.sha256);
});
