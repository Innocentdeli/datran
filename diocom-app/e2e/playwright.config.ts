import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * End-to-end suite for diocom-app (production build against an ephemeral PostgreSQL + Redis [+ core-reactor]).
 *
 *   npm run test:e2e            headless, desktop Chromium + Pixel 7 emulation
 *   npm run test:e2e:ui         Playwright UI mode
 *
 * Env:
 *   REACTOR_BIN=<path>          start that core-reactor and use STORAGE_BACKEND=reactor (default: local storage)
 *   E2E_SKIP_BUILD=1            reuse an existing .next build (faster local re-runs)
 *   E2E_BASE_URL=<url>          run against an already running server (no provisioning; seeded user must exist)
 *   PW_CHANNEL=chrome|msedge|chromium   browser (default: installed Chrome, else Edge, locally; bundled Chromium in CI)
 *   E2E_LOG_LEVEL=info          app log level (server log: e2e/.cache/server-<run>.log)
 *
 * Docker is required for provisioning; without it every test is skipped with an explanation.
 * Note: Playwright starts `webServer` before `globalSetup`, so provisioning runs in the webServer command
 * (support/serve.mjs); global-setup.ts verifies it and global-teardown.ts cleans up.
 */

// The config is evaluated by the runner and again by every worker: values chosen here are stored in process.env
// (inherited by workers and the webServer) so all of them agree.
function pickPort(): number {
    // Synchronous free-port probe (config evaluation is synchronous).
    const out = execFileSync(process.execPath, ['-e', `const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})`]);
    return Number(out.toString());
}

const env = process.env;
env.E2E_RUN_ID ||= `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
env.E2E_USER_EMAIL ||= 'e2e-user@example.test';
env.E2E_USER_PASSWORD ||= `pw-${randomBytes(9).toString('base64url')}`;
env.METRICS_TOKEN ||= randomBytes(16).toString('hex');
// Known to the specs so they can assert these never leak (security spec).
env.E2E_APP_SECRET ||= randomBytes(32).toString('base64url');
env.E2E_DB_PASSWORD ||= randomBytes(12).toString('hex');
if (!env.E2E_BASE_URL && env.E2E_DOCKER === undefined) {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 });
    env.E2E_DOCKER = r.status === 0 && r.stdout.trim() ? '1' : '0';
    if (env.E2E_DOCKER !== '1') {
        env.E2E_SKIP_REASON = 'Docker is not available (needed for the ephemeral PostgreSQL/Redis). Install/start Docker, or set E2E_BASE_URL to test a running server.';
    }
}
if (!env.E2E_BASE_URL && env.E2E_DOCKER === '1') env.E2E_PORT ||= String(pickPort());

const baseURL = env.E2E_BASE_URL || `http://127.0.0.1:${env.E2E_PORT || 3999}`;
const provision = !env.E2E_BASE_URL && env.E2E_DOCKER === '1';

function defaultChannel(): string | undefined {
    if (env.PW_CHANNEL) return env.PW_CHANNEL === 'chromium' ? undefined : env.PW_CHANNEL;
    if (env.CI) return undefined; // `npx playwright install chromium`
    const candidates: Array<[string, string[]]> = [
        ['chrome', ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app', '/opt/google/chrome/chrome']],
        ['msedge', ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/Applications/Microsoft Edge.app', '/opt/microsoft/msedge/msedge']],
    ];
    for (const [channel, paths] of candidates) if (paths.some((p) => existsSync(p))) return channel;
    return undefined;
}
const channel = defaultChannel();

export default defineConfig({
    testDir: './specs',
    outputDir: './test-results',
    fullyParallel: true,
    forbidOnly: !!env.CI,
    retries: env.CI ? 1 : 0,
    workers: Number(env.E2E_WORKERS) || 2,
    timeout: 120_000,
    expect: { timeout: 15_000 },
    globalSetup: './support/global-setup.ts',
    globalTeardown: './support/global-teardown.ts',
    reporter: env.CI
        ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['github']]
        : [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
    use: {
        baseURL,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
        actionTimeout: 20_000,
        navigationTimeout: 45_000,
        channel,
    },
    projects: [
        { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], channel } },
        { name: 'mobile-pixel7', use: { ...devices['Pixel 7'], channel } },
    ],
    webServer: provision
        ? {
            command: 'node e2e/support/serve.mjs',
            cwd: join(__dirname, '..'),
            url: `${baseURL}/api/health/ready`,
            // Docker image pulls + `next build` on a cold cache.
            timeout: 15 * 60_000,
            reuseExistingServer: false,
            stdout: 'ignore',
            stderr: 'pipe',
            gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
        }
        : undefined,
});
