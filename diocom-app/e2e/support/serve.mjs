#!/usr/bin/env node
// Playwright `webServer.command`: provisions the ephemeral environment (./environment.mjs), builds and starts the
// app in production mode, and stays in the foreground until the server exits or the runner stops it.
//
// Playwright starts the webServer BEFORE globalSetup, so provisioning has to live here; ./global-setup.ts checks
// the result and ./global-teardown.ts removes everything recorded in the run's state file.
import { startEnvironment, stopEnvironment, log } from './environment.mjs';

const runId = process.env.E2E_RUN_ID;
let server;
let stopping = false;

async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    try { server?.kill(); } catch { /* gone */ }
    await stopEnvironment(runId).catch((e) => log('cleanup failed:', e.message));
    process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void shutdown(0));

try {
    server = await startEnvironment();
    server.on('exit', (code) => {
        if (!stopping) log(`next start stopped (code ${code}); server log in e2e/.cache`);
        void shutdown(code ?? 1);
    });
} catch (e) {
    log('environment setup failed:', e?.stack || e);
    await shutdown(1);
}
