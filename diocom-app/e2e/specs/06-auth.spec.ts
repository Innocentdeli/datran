import { test, expect, makeFile, newAccount, uploadViaLanding, shareIdOf, appAlerts, signInViaApi } from '../fixtures';

test.describe('accounts', () => {
    test('sign up with credentials, upload, dashboard lists it, sign out, sign back in', async ({ page }) => {
        const account = newAccount('signup');
        await page.goto('/auth/signin');
        await expect(page.getByRole('heading', { name: 'Sign in to Datran' })).toBeVisible();
        await page.getByRole('button', { name: "Don't have an account? Create one" }).click();
        await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
        await page.getByLabel('Email address').fill(account.email);
        await page.getByLabel('Password').fill(account.password);
        await page.getByRole('button', { name: 'Sign Up', exact: true }).click();
        await page.waitForURL('**/dashboard');
        await expect(page.getByRole('heading', { name: 'My transfers' })).toBeVisible();
        await expect(page.getByText('Your history is clear')).toBeVisible();

        // Upload while signed in (Free plan) -> listed on the dashboard.
        const file = await makeFile('signed-in-upload.bin', 64 * 1024);
        await page.goto('/');
        const link = await uploadViaLanding(page, [file]);
        await page.goto('/dashboard');
        const card = page.getByRole('link', { name: new RegExp(file.name) });
        await expect(card).toBeVisible();
        await expect(card).toHaveAttribute('href', `/v1/${shareIdOf(link)}`);
        await expect(page.getByText(/^1$/).first()).toBeVisible();

        // Sign out (header button) -> signed-out header, dashboard requires sign-in again.
        await page.getByRole('button', { name: 'Sign out' }).click();
        await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/auth\/signin/);

        // Sign in again with the same credentials.
        await page.getByLabel('Email address').fill(account.email);
        await page.getByLabel('Password').fill(account.password);
        await page.getByRole('button', { name: 'Sign In', exact: true }).click();
        await page.waitForURL('**/dashboard');
        await expect(page.getByRole('link', { name: new RegExp(file.name) })).toBeVisible();
    });

    test('wrong password is refused with a clear message', async ({ page, seededUser }) => {
        await page.goto('/auth/signin');
        await page.getByLabel('Email address').fill(seededUser.email);
        await page.getByLabel('Password').fill('definitely-wrong');
        await page.getByRole('button', { name: 'Sign In', exact: true }).click();
        await expect(appAlerts(page)).toContainText('Invalid email or password');
        await expect(page).toHaveURL(/\/auth\/signin/);
    });

    test('seeded user (support/seed.mts) signs in via the API and reaches the dashboard', async ({ page, seededUser }) => {
        await signInViaApi(page.request, seededUser);
        await page.goto('/dashboard');
        await expect(page.getByRole('heading', { name: 'My transfers' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
        const session = await (await page.request.get('/api/auth/session')).json();
        expect(session.user.email).toBe(seededUser.email);
    });
});
