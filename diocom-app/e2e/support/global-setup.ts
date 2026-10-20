import type { FullConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Runs after the webServer (support/serve.mjs) has provisioned PostgreSQL/Redis/reactor, migrated, seeded, built
 * and started the app. Verifies readiness and the seeded login, and explains a Docker-less skip.
 */
export default async function globalSetup(config: FullConfig) {
    const reason = process.env.E2E_SKIP_REASON;
    if (reason) {
        console.warn(`\n[e2e] SKIPPING the end-to-end suite: ${reason}\n`);
        return;
    }
    const baseURL = config.projects[0]?.use.baseURL as string;
    const ready = await fetch(`${baseURL}/api/health/ready`).catch((e: Error) => e);
    if (ready instanceof Error || !ready.ok) {
        throw new Error(`[e2e] ${baseURL}/api/health/ready is not ready: ${ready instanceof Error ? ready.message : ready.status}`);
    }
    // Seeded user can sign in (NextAuth credentials flow).
    const csrfRes = await fetch(`${baseURL}/api/auth/csrf`);
    const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };
    const cookie = csrfRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const login = await fetch(`${baseURL}/api/auth/callback/credentials`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie, 'X-Forwarded-For': '198.18.0.1' },
        body: new URLSearchParams({ csrfToken, email: process.env.E2E_USER_EMAIL!, password: process.env.E2E_USER_PASSWORD!, json: 'true' }),
    });
    if (!login.headers.getSetCookie().some((c) => c.includes('next-auth.session-token'))) {
        throw new Error(`[e2e] the seeded user ${process.env.E2E_USER_EMAIL} cannot sign in (HTTP ${login.status})`);
    }
    if (process.env.E2E_RUN_ID && !process.env.E2E_BASE_URL) {
        try {
            const state = JSON.parse(readFileSync(join(__dirname, '..', '.cache', `run-${process.env.E2E_RUN_ID}.json`), 'utf8'));
            console.log(`[e2e] run ${state.runId}: ${state.baseURL}, storage=${state.storageBackend}, server log ${state.serverLog}`);
        } catch { /* informational only */ }
    }
}
