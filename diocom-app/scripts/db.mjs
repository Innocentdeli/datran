#!/usr/bin/env node
/**
 * Database migration CLI (see src/db/migrate.ts and migrations/).
 *
 *   npm run db:migrate     apply pending migrations (baselines a legacy initializeSchema database first)
 *   npm run db:status      show applied / pending migrations and integrity errors (read-only; exit 1 if not current)
 *
 * Env: DATABASE_URL (required), DB_MIGRATIONS_DIR (default ./migrations), DB_MIGRATE_LOCK_TIMEOUT_MS (default 120000).
 * Loads .env.local when present (npm scripts pass --env-file-if-exists). Requires Node >= 22.18 (type stripping).
 * Nothing here drops or resets data.
 */
const { runMigrations, migrationStatus } = await import('../src/db/migrate.ts');

const cmd = process.argv[2] || 'status';

function fmtDate(d) {
    return d instanceof Date ? d.toISOString() : String(d);
}

async function main() {
    if (!process.env.DATABASE_URL) {
        console.error('DATABASE_URL is not set (e.g. postgres://user:pass@localhost:5432/datran).');
        return 2;
    }
    if (cmd === 'migrate') {
        const r = await runMigrations();
        console.info(`[migrate] Schema version: ${r.version}`);
        return 0;
    }
    if (cmd === 'status') {
        const s = await migrationStatus();
        for (const a of s.applied) {
            console.info(`  applied  ${String(a.version).padStart(4, '0')}_${a.name}  ${fmtDate(a.applied_at)}${a.baseline ? '  (baseline)' : ''}`);
        }
        for (const p of s.pending) console.info(`  pending  ${p.filename}`);
        if (s.legacy) console.info('  note: legacy schema without schema_migrations; `db:migrate` will verify and baseline it at 0001.');
        for (const e of s.errors) console.error(`  ERROR    ${e}`);
        if (s.errors.length) return 1;
        if (s.pending.length) { console.info(`${s.pending.length} pending migration(s).`); return 1; }
        console.info('Database schema is up to date.');
        return 0;
    }
    console.error(`Unknown command "${cmd}". Use: migrate | status`);
    return 2;
}

main().then(
    (code) => { process.exitCode = code; },
    (err) => { console.error(`[migrate] ${err && err.message ? err.message : err}`); process.exitCode = 1; },
);
