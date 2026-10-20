// Ephemeral environment for the Playwright suite: PostgreSQL + Redis in Docker (random host ports), an optional
// core-reactor (REACTOR_BIN), migrations, a seeded user, then `next build` + `next start` in production mode.
//
// Everything a run creates is recorded in a state file (e2e/.cache/run-<id>.json) and labelled
// `diocom-e2e=<id>` (containers), so ./global-teardown.ts can remove it even when the launcher was killed hard
// (Playwright kills the webServer process tree with SIGKILL / taskkill /F).
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CACHE_DIR = join(APP_DIR, 'e2e', '.cache');
export const LABEL = 'diocom-e2e';
const IS_WIN = process.platform === 'win32';

export const log = (...a) => console.error('[e2e-env]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ state file

export const statePath = (runId) => join(CACHE_DIR, `run-${runId}.json`);

export function readState(runId) {
    try {
        return JSON.parse(readFileSync(statePath(runId), 'utf8'));
    } catch {
        return { runId, containers: [], pids: [], dirs: [] };
    }
}

function updateState(runId, patch) {
    mkdirSync(CACHE_DIR, { recursive: true });
    const s = readState(runId);
    for (const [k, v] of Object.entries(patch)) s[k] = Array.isArray(s[k]) && Array.isArray(v) ? [...s[k], ...v] : v;
    writeFileSync(statePath(runId), JSON.stringify(s, null, 2));
    return s;
}

// ------------------------------------------------------------------------------------------------ helpers

export function dockerAvailable() {
    const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 && !!r.stdout.trim();
}

export function freePort() {
    return new Promise((res, rej) => {
        const s = createServer();
        s.once('error', rej);
        s.listen(0, '127.0.0.1', () => {
            const { port } = s.address();
            s.close(() => res(port));
        });
    });
}

function docker(args, opts = {}) {
    const r = spawnSync('docker', args, { encoding: 'utf8', timeout: opts.timeout ?? 300_000 });
    if (r.status !== 0) throw new Error(`docker ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim()}`);
    return r.stdout.trim();
}

/** Starts a labelled container publishing `containerPort` on a random 127.0.0.1 port; returns { id, port }. */
function runContainer(runId, image, containerPort, args = [], cmd = []) {
    const id = docker(['run', '-d', '--rm', '--label', `${LABEL}=${runId}`, '-p', `127.0.0.1::${containerPort}`, ...args, image, ...cmd]);
    updateState(runId, { containers: [id] });
    const mapping = docker(['port', id, String(containerPort)]).split(/\r?\n/)[0]; // 127.0.0.1:49153
    const port = Number(mapping.slice(mapping.lastIndexOf(':') + 1));
    if (!port) throw new Error(`could not read the host port of ${image}: "${mapping}"`);
    return { id, port };
}

async function waitFor(what, fn, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
        try {
            if (await fn()) return;
        } catch (e) {
            last = e;
        }
        await sleep(300);
    }
    throw new Error(`${what} did not become ready within ${timeoutMs / 1000}s${last ? `: ${last.message}` : ''}`);
}

function redisPing(port) {
    return new Promise((res) => {
        const sock = connect(port, '127.0.0.1');
        let buf = '';
        sock.setTimeout(1000, () => { sock.destroy(); res(false); });
        sock.on('error', () => res(false));
        sock.on('connect', () => sock.write('PING\r\n'));
        sock.on('data', (d) => {
            buf += d.toString();
            if (buf.includes('\r\n')) { sock.end(); res(buf.startsWith('+PONG')); }
        });
    });
}

async function pgReady(url) {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2000 });
    try {
        await c.connect();
        await c.query('SELECT 1');
        return true;
    } finally {
        await c.end().catch(() => undefined);
    }
}

function run(cmd, args, env, what) {
    log(`${what}...`);
    const t0 = Date.now();
    const r = spawnSync(cmd, args, { cwd: APP_DIR, env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 15 * 60_000 });
    if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status ?? r.signal})`);
    log(`${what} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// ------------------------------------------------------------------------------------------------ environment

/** Test-server environment shared by the launcher and the specs (fixed values; ports/URLs are added at runtime). */
export const TEST_ENV = {
    // Plan limits (src/lib/billing/plans.ts): a ~1 MiB Free storage quota so the quota spec hits 402 quickly, and
    // a larger anonymous file limit for the resumable-upload specs.
    PLAN_FREE_STORAGE_GB: '0.001',
    PLAN_ANON_MAX_FILE_MB: '300',
    ALLOW_ANONYMOUS_UPLOADS: 'true',
    // Each test sends its own X-Forwarded-For (e2e/fixtures.ts) so per-IP rate limits never couple tests.
    TRUST_PROXY: 'true',
    RATE_LIMIT_MAX_REQUESTS: '100000',
    // Stripe / OAuth explicitly unset: billing must report "not configured" (empty values win over .env files).
    STRIPE_SECRET_KEY: '',
    STRIPE_WEBHOOK_SECRET: '',
    STRIPE_PRICE_PRO_MONTHLY: '',
    STRIPE_PRICE_PRO_YEARLY: '',
    GOOGLE_CLIENT_ID: '',
    GOOGLE_CLIENT_SECRET: '',
    FACEBOOK_CLIENT_ID: '',
    FACEBOOK_CLIENT_SECRET: '',
    // Quiet background work.
    PREFETCH_INTERVAL_MS: '0',
    CLEANUP_INTERVAL_MS: '0',
    LOG_LEVEL: process.env.E2E_LOG_LEVEL || 'warn',
    NEXT_TELEMETRY_DISABLED: '1',
};

/**
 * Provisions everything and starts the production server. Returns the child process of `next start`.
 * Env in: E2E_RUN_ID, E2E_PORT (required); REACTOR_BIN, E2E_SKIP_BUILD=1, E2E_USER_EMAIL/PASSWORD, METRICS_TOKEN.
 */
export async function startEnvironment() {
    const runId = process.env.E2E_RUN_ID;
    const port = Number(process.env.E2E_PORT);
    if (!runId || !port) throw new Error('E2E_RUN_ID and E2E_PORT must be set (playwright.config.ts does this)');
    const t0 = Date.now();
    mkdirSync(CACHE_DIR, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), `diocom-e2e-${runId}-`));
    updateState(runId, { dirs: [work], startedAt: new Date().toISOString() });

    // --- PostgreSQL + Redis (random host ports; tmpfs data, fsync off: throwaway) ---
    const pgPass = process.env.E2E_DB_PASSWORD || randomBytes(12).toString('hex');
    log('starting postgres + redis containers');
    const pgC = runContainer(runId, process.env.E2E_POSTGRES_IMAGE || 'postgres:16-alpine', 5432,
        ['-e', `POSTGRES_PASSWORD=${pgPass}`, '-e', 'POSTGRES_DB=datran', '--tmpfs', '/var/lib/postgresql/data'],
        ['-c', 'fsync=off', '-c', 'synchronous_commit=off', '-c', 'full_page_writes=off']);
    const redisC = runContainer(runId, process.env.E2E_REDIS_IMAGE || 'redis:7-alpine', 6379, [], ['--save', '', '--appendonly', 'no']);
    const databaseUrl = `postgres://postgres:${pgPass}@127.0.0.1:${pgC.port}/datran`;
    const redisUrl = `redis://127.0.0.1:${redisC.port}`;
    await waitFor('postgres', () => pgReady(databaseUrl), 90_000);
    await waitFor('redis', () => redisPing(redisC.port), 30_000);

    const baseURL = `http://127.0.0.1:${port}`;
    const secret = process.env.E2E_APP_SECRET || randomBytes(32).toString('base64url');
    const env = {
        ...process.env,
        ...TEST_ENV,
        NODE_ENV: 'production',
        PORT: String(port),
        NEXTAUTH_URL: baseURL,
        APP_URL: baseURL,
        DIOCOM_SECRET: secret,
        NEXTAUTH_SECRET: secret,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        REQUIRE_REDIS: 'true',
        KV_PREFIX: `e2e-${runId}:`,
        DIOCOM_STORAGE_PATH: join(work, 'storage'),
        UPLOAD_STAGING_DIR: join(work, 'staging'),
        METRICS_TOKEN: process.env.METRICS_TOKEN || randomBytes(16).toString('hex'),
    };
    delete env.NODE_OPTIONS; // the runner's loader flags must not leak into Next

    // --- reactor (optional) ---
    const reactorBin = process.env.REACTOR_BIN;
    if (reactorBin) {
        if (!existsSync(reactorBin)) throw new Error(`REACTOR_BIN=${reactorBin} does not exist`);
        const rPort = await freePort();
        const rToken = randomBytes(16).toString('hex');
        const stateDir = join(work, 'reactor');
        mkdirSync(stateDir, { recursive: true });
        const rEnv = { ...env, REACTOR_PORT: String(rPort), REACTOR_TOKEN: rToken, REACTOR_STATE_DIR: stateDir, REACTOR_BIND: '127.0.0.1' };
        delete rEnv.REACTOR_CLUSTER_TOKEN;
        delete rEnv.REACTOR_PEERS;
        const out = openSync(join(CACHE_DIR, `reactor-${runId}.log`), 'a');
        const child = spawn(reactorBin, [], { env: rEnv, stdio: ['ignore', out, out] });
        updateState(runId, { pids: [child.pid] });
        const url = `http://127.0.0.1:${rPort}`;
        await waitFor('reactor', async () => {
            if (child.exitCode !== null) throw new Error(`reactor exited (code ${child.exitCode})`);
            return (await fetch(`${url}/health`)).ok;
        }, 30_000);
        Object.assign(env, { STORAGE_BACKEND: 'reactor', REACTOR_URL: url, REACTOR_TOKEN: rToken, REACTOR_PORT: String(rPort), REACTOR_STATE_DIR: stateDir });
        log(`reactor up at ${url} (${reactorBin})`);
    } else {
        env.STORAGE_BACKEND = 'local';
    }
    updateState(runId, { storageBackend: env.STORAGE_BACKEND, baseURL });

    // --- schema + seed (the app's own migration CLI and auth repository) ---
    run(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/db.mjs', 'migrate'], env, 'migrations');
    run(process.execPath, ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        '--import', './e2e/support/register-alias.mjs', 'e2e/support/seed.mts'], { ...env, LOG_LEVEL: 'warn' }, 'seed');

    // --- build + start (production) ---
    const nextBin = join(APP_DIR, 'node_modules', 'next', 'dist', 'bin', 'next');
    if (process.env.E2E_SKIP_BUILD === '1' && existsSync(join(APP_DIR, '.next', 'BUILD_ID'))) {
        log('E2E_SKIP_BUILD=1: reusing the existing .next build');
    } else {
        run(process.execPath, [nextBin, 'build'], env, 'next build');
    }
    const logFile = join(CACHE_DIR, `server-${runId}.log`);
    const out = openSync(logFile, 'a');
    const server = spawn(process.execPath, [nextBin, 'start', '-p', String(port), '-H', '127.0.0.1'], { cwd: APP_DIR, env, stdio: ['ignore', out, out] });
    updateState(runId, { pids: [server.pid], serverLog: logFile });
    log(`next start (pid ${server.pid}) on ${baseURL}; storage=${env.STORAGE_BACKEND}; log: ${logFile}; provisioned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return server;
}

// ------------------------------------------------------------------------------------------------ teardown

function killPid(pid) {
    if (!pid) return;
    try {
        if (IS_WIN) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        else process.kill(pid, 'SIGKILL');
    } catch { /* already gone */ }
}

/** Removes everything recorded for `runId` (processes we started, labelled containers, temp dirs). Idempotent. */
export async function stopEnvironment(runId) {
    const s = readState(runId);
    for (const pid of s.pids || []) killPid(pid);
    if (dockerAvailable()) {
        const ids = spawnSync('docker', ['ps', '-aq', '--filter', `label=${LABEL}=${runId}`], { encoding: 'utf8' }).stdout.trim().split(/\s+/).filter(Boolean);
        const all = [...new Set([...(s.containers || []), ...ids])];
        if (all.length) spawnSync('docker', ['rm', '-f', '-v', ...all], { stdio: 'ignore' });
    }
    for (const d of s.dirs || []) {
        for (let i = 0; i < 10 && existsSync(d); i++) {
            try { rmSync(d, { recursive: true, force: true }); } catch { await sleep(500); }
        }
    }
    rmSync(statePath(runId), { force: true });
}
