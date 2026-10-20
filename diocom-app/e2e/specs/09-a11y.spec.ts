import AxeBuilder from '@axe-core/playwright';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect, makeFile, uploadViaLanding, openAsRecipient, signInViaApi } from '../fixtures';

/**
 * axe-core (WCAG 2.0/2.1/2.2 A + AA rules) on the main pages. Serious/critical violations fail the test; minor and
 * moderate ones are attached to the report and printed so they stay visible.
 */
async function scan(page: Page, testInfo: TestInfo, label: string) {
    // Let entrance animations (framer-motion) settle so contrast is measured on final colors.
    await page.waitForTimeout(800);
    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
    const fmt = (v: (typeof results.violations)[number]) =>
        `[${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node${v.nodes.length === 1 ? '' : 's'})\n` +
        v.nodes.slice(0, 5).map((n) => `    ${n.target.join(' ')} :: ${n.failureSummary?.split('\n').join(' | ')}`).join('\n');
    await testInfo.attach(`axe-${label}.json`, { body: JSON.stringify(results.violations, null, 2), contentType: 'application/json' });
    const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    const other = results.violations.filter((v) => !blocking.includes(v));
    if (other.length) {
        const msg = `${label}: ${other.length} minor/moderate axe finding(s):\n${other.map(fmt).join('\n')}`;
        console.warn(msg);
        testInfo.annotations.push({ type: 'axe-minor', description: msg });
    }
    expect(blocking.map(fmt), `${label}: serious/critical accessibility violations`).toEqual([]);
}

test.describe('accessibility (axe)', () => {
    test('landing', async ({ page }, testInfo) => {
        await page.goto('/');
        await scan(page, testInfo, 'landing');
    });

    test('landing with a share link', async ({ page }, testInfo) => {
        await uploadViaLanding(page, [await makeFile('a11y.txt', 4096)]);
        await scan(page, testInfo, 'landing-done');
    });

    test('viewer', async ({ page, newRecipientContext }, testInfo) => {
        const link = await uploadViaLanding(page, [await makeFile('a11y-viewer.pdf.bin', 8192)]);
        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        await expect(viewer.getByRole('button', { name: /^Download/ })).toBeVisible();
        await scan(viewer, testInfo, 'viewer');
    });

    test('password gate', async ({ page, newRecipientContext }, testInfo) => {
        const link = await uploadViaLanding(page, [await makeFile('a11y-locked.bin', 4096)], { password: 'open sesame' });
        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        await expect(viewer.getByRole('button', { name: 'Unlock file' })).toBeVisible();
        await scan(viewer, testInfo, 'password-gate');
    });

    test('sign-in', async ({ page }, testInfo) => {
        await page.goto('/auth/signin');
        await expect(page.getByRole('heading', { name: 'Sign in to Datran' })).toBeVisible();
        await scan(page, testInfo, 'signin');
    });

    test('dashboard (with a file)', async ({ page, freshAccount }, testInfo) => {
        await signInViaApi(page.request, freshAccount);
        await uploadViaLanding(page, [await makeFile('a11y-dash.bin', 4096)]);
        await page.goto('/dashboard');
        await expect(page.getByRole('heading', { name: 'My transfers' })).toBeVisible();
        await scan(page, testInfo, 'dashboard');
    });

    test('billing', async ({ signedInPage: page }, testInfo) => {
        await page.goto('/billing');
        await expect(page.getByText('Current plan')).toBeVisible();
        await scan(page, testInfo, 'billing');
    });
});
