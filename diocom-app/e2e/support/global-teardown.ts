/**
 * Removes everything this run provisioned: the processes support/serve.mjs started (next start, core-reactor),
 * the `diocom-e2e=<run>` containers and the temp storage. Runs before Playwright stops the webServer, and is
 * needed because that stop is a hard kill on Windows (the launcher's own cleanup never runs there).
 */
export default async function globalTeardown() {
    const runId = process.env.E2E_RUN_ID;
    if (!runId || process.env.E2E_SKIP_REASON || process.env.E2E_BASE_URL) return;
    if (process.env.E2E_KEEP_ENV === '1') {
        console.log(`[e2e] E2E_KEEP_ENV=1: leaving run ${runId} running (clean up with: docker rm -f $(docker ps -q --filter label=diocom-e2e=${runId}))`);
        return;
    }
    const { stopEnvironment } = await import('./environment.mjs');
    await stopEnvironment(runId);
}
