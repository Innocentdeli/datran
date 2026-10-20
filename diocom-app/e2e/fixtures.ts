import { test as base, expect, type APIRequestContext, type BrowserContext, type Page, type Request } from '@playwright/test';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, writeSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export { expect };

export interface Account {
    email: string;
    password: string;
}

export interface TestFile {
    path: string;
    name: string;
    size: number;
    sha256: string;
}

const FILES_DIR = join(__dirname, '.cache', 'files');

/** A unique documentation-range client IP per test, so per-IP rate limits (TRUST_PROXY=true) never couple tests. */
function testIp(): string {
    const b = randomBytes(2);
    return `198.18.${b[0]}.${(b[1] % 250) + 2}`;
}

export function sha256File(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const h = createHash('sha256');
        createReadStream(path).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
}

/**
 * Writes a file of `size` random bytes (cached per name+size+seed for the run's lifetime) and returns its hash.
 * Random content defeats compression/dedup, so sizes on the wire are real.
 */
export async function makeFile(name: string, size: number, seed = ''): Promise<TestFile> {
    mkdirSync(FILES_DIR, { recursive: true });
    const tag = createHash('sha1').update(`${name}:${size}:${seed}:${process.env.E2E_RUN_ID}`).digest('hex').slice(0, 10);
    const dir = join(FILES_DIR, tag);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    if (!existsSync(path) || statSync(path).size !== size) {
        const fd = openSync(path, 'w');
        try {
            const chunk = 4 * 1024 * 1024;
            for (let off = 0; off < size; off += chunk) writeSync(fd, randomBytes(Math.min(chunk, size - off)));
        } finally {
            closeSync(fd);
        }
    }
    return { path, name, size, sha256: await sha256File(path) };
}

export async function fixtureFile(name: string): Promise<TestFile> {
    const path = join(__dirname, 'fixtures', name);
    const buf = readFileSync(path);
    return { path, name, size: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/** NextAuth credentials sign-in (or sign-up) through the app's API; the session cookie lands in `request`'s jar. */
export async function signInViaApi(request: APIRequestContext, account: Account, opts: { signUp?: boolean } = {}): Promise<void> {
    const csrf = await request.get('/api/auth/csrf');
    expect(csrf.ok()).toBeTruthy();
    const { csrfToken } = await csrf.json();
    const res = await request.post('/api/auth/callback/credentials', {
        form: { csrfToken, email: account.email, password: account.password, isSignUp: opts.signUp ? 'true' : 'false', json: 'true' },
        maxRedirects: 0,
    });
    expect(res.status(), `credentials ${opts.signUp ? 'sign-up' : 'sign-in'} for ${account.email}`).toBeLessThan(400);
    const session = await (await request.get('/api/auth/session')).json();
    expect(session?.user?.email, `session after ${opts.signUp ? 'sign-up' : 'sign-in'}`).toBe(account.email);
}

export function newAccount(prefix = 'e2e'): Account {
    return { email: `${prefix}-${randomBytes(5).toString('hex')}@example.test`, password: `pw-${randomBytes(9).toString('base64url')}` };
}

// ------------------------------------------------------------------------------------------------ landing page

/** Selects files through the native file chooser ("Choose files" / "Add files"). */
export async function chooseFiles(page: Page, files: TestFile[]): Promise<void> {
    const chooser = page.waitForEvent('filechooser');
    const button = page.getByRole('button', { name: /^(Choose files|Add files)$/ }).first();
    await button.click();
    await (await chooser).setFiles(files.map((f) => f.path));
}

export const uploadHeading = (page: Page) => page.locator('#upload-heading');

/** role="alert" elements of the app (excludes Next's always-present, empty route announcer). */
export const appAlerts = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

/** Clicks "Upload & get link" and waits for the share link; returns it (…/v1/<id>#key=…). */
export async function startUpload(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Upload & get link' }).click();
}

export async function waitForShareLink(page: Page, timeout = 120_000): Promise<string> {
    await expect(uploadHeading(page)).toHaveText(/Your link is ready|links ready/, { timeout });
    const input = page.getByRole('textbox', { name: /^Share link/ }).first();
    const link = await input.inputValue();
    expect(link).toMatch(/\/v1\/[^/#]+#key=[A-Za-z0-9_-]+$/);
    return link;
}

/** Full landing flow: choose → (password) → upload → link. */
export async function uploadViaLanding(page: Page, files: TestFile[], opts: { password?: string; timeout?: number } = {}): Promise<string> {
    if (!page.url().startsWith('http')) await page.goto('/');
    await chooseFiles(page, files);
    if (opts.password) await page.getByRole('textbox', { name: /^Password/ }).fill(opts.password);
    await startUpload(page);
    return waitForShareLink(page, opts.timeout);
}

export const shareIdOf = (link: string) => new URL(link).pathname.split('/').pop()!;

/** The tus upload requests (/api/uploads...) a page makes. */
export function tusRequests(page: Page): Request[] {
    const seen: Request[] = [];
    page.on('request', (r) => { if (new URL(r.url()).pathname.startsWith('/api/uploads')) seen.push(r); });
    return seen;
}

/**
 * Throttles the page's uploads (Chromium network emulation) so mid-upload states are observable on a fast
 * loopback. `context.setOffline()` replaces these conditions (unthrottled afterwards).
 */
export async function throttleUploads(page: Page, bytesPerSecond: number): Promise<Network> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    const apply = (offline: boolean, up: number) =>
        cdp.send('Network.emulateNetworkConditions', { offline, latency: 0, downloadThroughput: -1, uploadThroughput: up });
    await apply(false, bytesPerSecond);
    return {
        // The emulation of this CDP session takes precedence over Playwright's own, so both are switched.
        async setOffline(offline: boolean) {
            await page.context().setOffline(offline);
            await apply(offline, offline ? bytesPerSecond : -1);
        },
    };
}

export interface Network {
    /** context.setOffline() plus the throttling session (unthrottled once back online). */
    setOffline(offline: boolean): Promise<void>;
}

/** Current overall upload percentage (aria-valuenow of the "Upload progress" bar), or -1 when not shown. */
export async function uploadPercent(page: Page): Promise<number> {
    const bar = page.getByRole('progressbar', { name: 'Upload progress' });
    if (!(await bar.isVisible())) return -1;
    return Number((await bar.getAttribute('aria-valuenow')) ?? -1);
}

// ------------------------------------------------------------------------------------------------ viewer

/** Opens `link` in a fresh browser context (no shared storage/keys), as a recipient would. */
export async function openAsRecipient(newContext: () => Promise<BrowserContext>, link: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await newContext();
    const page = await context.newPage();
    await page.goto(link);
    return { context, page };
}

/** Clicks Download on the viewer, waits for the browser download and returns the saved file's SHA-256. */
export async function downloadAndHash(page: Page, saveDir: string): Promise<{ sha256: string; name: string; size: number }> {
    const button = page.getByRole('button', { name: /^Download/ });
    await expect(button).toBeEnabled();
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), button.click()]);
    const failure = await download.failure();
    expect(failure, 'download failure').toBeNull();
    const target = join(saveDir, `${Date.now()}-${download.suggestedFilename()}`);
    await download.saveAs(target);
    return { sha256: await sha256File(target), name: download.suggestedFilename(), size: statSync(target).size };
}

// ------------------------------------------------------------------------------------------------ fixtures

type Fixtures = {
    /** Skips everything (with the reason) when the environment could not be provisioned (no Docker). */
    envGuard: void;
    /** Pre-seeded credentials user (support/seed.mts). */
    seededUser: Account;
    /** `page` signed in as a fresh account. */
    signedInPage: Page;
    /** A fresh account created through the app's sign-up (independent quota/usage per test). */
    freshAccount: Account;
    /** Creates another isolated browser context with the same device/options as the test's project. */
    newRecipientContext: () => Promise<BrowserContext>;
};

// Fixture callbacks name Playwright's `use` argument `provide` so react-hooks/rules-of-hooks doesn't mistake it for React's use().
export const test = base.extend<Fixtures>({
    envGuard: [async ({}, provide, testInfo) => {
        testInfo.skip(!!process.env.E2E_SKIP_REASON, process.env.E2E_SKIP_REASON);
        await provide();
    }, { auto: true }],

    extraHTTPHeaders: async ({ extraHTTPHeaders }, provide) => {
        await provide({ ...extraHTTPHeaders, 'X-Forwarded-For': testIp() });
    },

    seededUser: async ({}, provide) => {
        await provide({ email: process.env.E2E_USER_EMAIL!, password: process.env.E2E_USER_PASSWORD! });
    },

    // A fresh account per test: the app limits sign-ins per email (10 / 5 min), so sharing the seeded user across
    // every test and project would trip it. The seeded user is exercised by global-setup and 06-auth.
    signedInPage: async ({ page, freshAccount }, provide) => {
        await signInViaApi(page.request, freshAccount);
        await provide(page);
    },

    freshAccount: async ({ playwright, baseURL }, provide) => {
        const account = newAccount();
        const request = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-Forwarded-For': testIp() } });
        await signInViaApi(request, account, { signUp: true });
        await request.dispose();
        await provide(account);
    },

    newRecipientContext: async ({ browser, baseURL, contextOptions, viewport, userAgent, isMobile, hasTouch, deviceScaleFactor, extraHTTPHeaders }, provide) => {
        const contexts: BrowserContext[] = [];
        await provide(async () => {
            const ctx = await browser.newContext({
                ...contextOptions,
                baseURL,
                viewport,
                userAgent,
                isMobile,
                hasTouch,
                deviceScaleFactor,
                extraHTTPHeaders: { ...extraHTTPHeaders, 'X-Forwarded-For': testIp() },
                acceptDownloads: true,
            });
            contexts.push(ctx);
            return ctx;
        });
        await Promise.all(contexts.map((c) => c.close()));
    },
});
