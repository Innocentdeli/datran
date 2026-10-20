import type { APIRequestContext } from '@playwright/test';
import { test, expect, makeFile, uploadViaLanding, openAsRecipient, signInViaApi, shareIdOf } from '../fixtures';

const EXPECTED_HEADERS: Record<string, RegExp> = {
    'x-content-type-options': /^nosniff$/,
    'x-frame-options': /^SAMEORIGIN$/i,
    'content-security-policy': /frame-ancestors 'self'/,
    'referrer-policy': /^strict-origin-when-cross-origin$/,
    'permissions-policy': /camera=\(\)/,
};

function secrets(): Array<[string, string]> {
    const s: Array<[string, string | undefined]> = [
        ['DIOCOM_SECRET/NEXTAUTH_SECRET', process.env.E2E_APP_SECRET],
        ['METRICS_TOKEN', process.env.METRICS_TOKEN],
        ['database password', process.env.E2E_DB_PASSWORD],
        ['seeded user password', process.env.E2E_USER_PASSWORD],
    ];
    return s.filter((x): x is [string, string] => !!x[1]);
}

const SECRET_PATTERNS: Array<[string, RegExp]> = [
    ['postgres URL', /postgres(ql)?:\/\/[^\s"'<]+@/i],
    ['redis URL', /redis:\/\/[^\s"'<]+/i],
    ['password hash', /"password_hash"|\$(pbkdf2|scrypt)[^"]{20,}/i],
    ['Stripe secret key', /\b(sk|rk)_(live|test)_[A-Za-z0-9]{10,}/],
    ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/** Fetches a page and the first-party scripts it references, returning all of the text. */
async function pageAndScripts(request: APIRequestContext, path: string, expectedStatus = 200): Promise<string> {
    const res = await request.get(path);
    expect(res.status(), path).toBe(expectedStatus);
    const html = await res.text();
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]).filter((u) => u.startsWith('/'));
    const scripts = await Promise.all(srcs.map(async (u) => (await request.get(u)).text()));
    return [html, ...scripts].join('\n');
}

function assertNoSecrets(text: string, where: string) {
    for (const [name, value] of secrets()) expect(text.includes(value), `${name} in ${where}`).toBe(false);
    for (const [name, re] of SECRET_PATTERNS) expect(re.exec(text)?.[0] ?? null, `${name} in ${where}`).toBeNull();
}

test.describe('security', () => {
    test('security headers on pages, API routes and static assets', async ({ request, page }) => {
        const link = await uploadViaLanding(page, [await makeFile('headers.bin', 2048)]);
        const paths = ['/', '/auth/signin', `/v1/${shareIdOf(link)}`, '/api/health/live', '/api/billing/usage', '/e2e-sw.js', '/does-not-exist'];
        for (const path of paths) {
            const res = await request.get(path, { maxRedirects: 0 });
            const h = res.headers();
            for (const [name, re] of Object.entries(EXPECTED_HEADERS)) expect(h[name], `${name} on ${path}`).toMatch(re);
            expect(h['x-powered-by'], `x-powered-by on ${path}`).toBeUndefined();
        }
    });

    test('/api/metrics requires the bearer token', async ({ request }) => {
        const none = await request.get('/api/metrics');
        expect([401, 404]).toContain(none.status());
        expect(await none.text()).not.toContain('diocom_');
        const wrong = await request.get('/api/metrics', { headers: { Authorization: 'Bearer nope' } });
        expect([401, 404]).toContain(wrong.status());
        if (process.env.METRICS_TOKEN && !process.env.E2E_BASE_URL) {
            const ok = await request.get('/api/metrics', { headers: { Authorization: `Bearer ${process.env.METRICS_TOKEN}` } });
            expect(ok.status()).toBe(200);
            expect(await ok.text()).toContain('# HELP');
        }
    });

    test('no secrets in page HTML or client bundles (anonymous and signed in)', async ({ page, request, freshAccount, newRecipientContext }) => {
        const link = await uploadViaLanding(page, [await makeFile('secret-scan.bin', 2048)], { password: 'scan-me-pw' });
        for (const path of ['/', '/auth/signin', `/v1/${shareIdOf(link)}`]) {
            assertNoSecrets(await pageAndScripts(request, path), path);
        }
        assertNoSecrets(await pageAndScripts(request, '/does-not-exist', 404), '404 page');
        // The file password never comes back from the server.
        const viewerHtml = await (await request.get(`/v1/${shareIdOf(link)}`)).text();
        expect(viewerHtml).not.toContain('scan-me-pw');

        await signInViaApi(page.request, freshAccount);
        for (const path of ['/dashboard', '/billing']) {
            assertNoSecrets(await pageAndScripts(page.request, path), `${path} (signed in)`);
        }
        const session = await (await page.request.get('/api/auth/session')).json();
        assertNoSecrets(JSON.stringify(session), '/api/auth/session');

        // Rendered DOM of the unlocked viewer as well.
        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        await viewer.getByLabel('Password', { exact: true }).fill('scan-me-pw');
        await viewer.getByRole('button', { name: 'Unlock file' }).click();
        await expect(viewer.getByRole('heading', { name: 'secret-scan.bin' })).toBeVisible();
        const dom = await viewer.content();
        assertNoSecrets(dom, 'viewer DOM');
        expect(dom).not.toContain('scan-me-pw');
    });

    test('the link key never reaches the server', async ({ page, newRecipientContext }) => {
        const sent: string[] = [];
        const record = (r: import('@playwright/test').Request) => {
            // The fragment is never sent on the wire (Playwright may still report it as part of the URL).
            sent.push(r.url().split('#')[0], JSON.stringify(r.headers()));
            const body = r.postDataBuffer();
            if (body && body.length < 4 * 1024 * 1024) sent.push(body.toString('latin1'));
        };
        page.on('request', record);
        const link = await uploadViaLanding(page, [await makeFile('key-check.bin', 96 * 1024)]);
        const key = link.split('#key=')[1];
        const { page: viewer } = await openAsRecipient(newRecipientContext, link);
        viewer.on('request', record);
        await viewer.getByRole('button', { name: /^Download/ }).click();
        await viewer.waitForTimeout(2_000);
        expect(sent.length).toBeGreaterThan(0);
        expect(sent.filter((s) => s.includes(key))).toEqual([]);
    });
});
