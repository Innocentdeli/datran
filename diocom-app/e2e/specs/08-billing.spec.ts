import { test, expect, makeFile, signInViaApi, uploadViaLanding } from '../fixtures';

test.describe('billing without Stripe', () => {
    test('shows "not configured", the Free plan and real usage numbers', async ({ page, freshAccount }) => {
        await signInViaApi(page.request, freshAccount);
        await page.goto('/');
        await uploadViaLanding(page, [await makeFile('usage.bin', 100 * 1024)]);

        await page.goto('/billing');
        await expect(page.getByRole('main').getByText('Billing is not configured on this server. All accounts use the Free plan.')).toBeVisible();
        await expect(page.getByText('Current plan')).toBeVisible();
        await expect(page.getByText('Free', { exact: true }).first()).toBeVisible();
        // No checkout buttons without Stripe.
        await expect(page.getByRole('button', { name: /Upgrade ·/ })).toHaveCount(0);
        await expect(page.getByRole('button', { name: /^Buy / })).toHaveCount(0);

        // Usage: the ciphertext of the 100 KB upload against the (test) 1 MiB Free quota.
        const storage = page.getByRole('progressbar', { name: 'Storage' });
        await expect(storage).toBeVisible();
        const pct = Number(await storage.getAttribute('aria-valuenow'));
        expect(pct).toBeGreaterThanOrEqual(9);
        expect(pct).toBeLessThanOrEqual(11);
        await expect(page.getByText(/^1\d\d(\.\d)? KB \/ 1\.0 MB$/)).toBeVisible();
        await expect(page.getByRole('progressbar', { name: 'Downloads this month' })).toBeVisible();
        await expect(page.getByText(/1 uploads this month/)).toBeVisible();
        await expect(page.getByRole('table')).toContainText('Storage');

        // The API agrees with the page.
        const usage = await (await page.request.get('/api/billing/usage')).json();
        expect(usage.billing.configured).toBe(false);
        expect(usage.plan.id).toBe('free');
        expect(usage.usage.storageBytes).toBeGreaterThan(100 * 1024);
    });

    test('checkout is refused cleanly when billing is not configured', async ({ signedInPage: page }) => {
        const res = await page.request.post('/api/billing/checkout', { data: { kind: 'pro', interval: 'month' } });
        expect(res.status()).toBe(503);
        expect((await res.json()).code).toBe('BILLING_NOT_CONFIGURED');
    });
});
