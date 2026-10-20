/**
 * Seeds the ephemeral e2e database through the app's own repository/auth code (src/lib/auth/credentials.ts:
 * PostgresAdapter.createUser hashes the password exactly like a real sign-up).
 *
 *   node --experimental-transform-types --import ./e2e/support/register-alias.mjs e2e/support/seed.mts
 *
 * Env: DATABASE_URL (migrated), E2E_USER_EMAIL, E2E_USER_PASSWORD. Idempotent.
 */
import { PostgresAdapter } from '../../src/lib/auth/credentials.ts';
import db from '../../src/db/index.ts';

const email = process.env.E2E_USER_EMAIL;
const password = process.env.E2E_USER_PASSWORD;
if (!process.env.DATABASE_URL || !email || !password) {
    console.error('[seed] DATABASE_URL, E2E_USER_EMAIL and E2E_USER_PASSWORD are required');
    process.exit(2);
}

try {
    const existing = await PostgresAdapter.getUserByEmail(email);
    if (existing) {
        console.info(`[seed] user ${email} already exists (${existing.id})`);
    } else {
        const user = await PostgresAdapter.createUser({ email, name: 'E2E User' }, 'credentials', password);
        console.info(`[seed] created user ${email} (${user.id})`);
    }
} finally {
    await (db as unknown as { end(): Promise<void> }).end();
}
// The app's modules start background timers (audit flush, metrics); don't wait for them.
process.exit(0);
