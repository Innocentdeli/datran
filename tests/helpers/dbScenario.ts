/**
 * Exercises the app's real database code paths (repositories/services in diocom-app/src plus the inline SQL of the
 * API routes, copied verbatim) against whatever backend src/db/index.ts selects. Used by
 * db_query_paths_local.test.ts (dev JSON store) and db_migrate_pg.test.ts (PostgreSQL migrated by migrations/),
 * proving the migrated schema and the emulator both match the code.
 *
 * Set DATABASE_URL / LOCAL_DB_PATH / DB_MIGRATIONS_DIR BEFORE calling loadApp(): the pool reads them on import.
 */
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const APP_DIR = path.resolve(__dirname, '..', '..', 'diocom-app');
const APP_SRC = path.join(APP_DIR, 'src');

let aliasInstalled = false;
/** Resolves the app's "@/..." path alias for ts-node. */
export function installAppAlias() {
    if (aliasInstalled) return;
    aliasInstalled = true;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Module = require('module');
    const orig = Module._resolveFilename;
    Module._resolveFilename = function (request: string, ...rest: unknown[]) {
        if (request.startsWith('@/')) request = path.join(APP_SRC, request.slice(2));
        return orig.call(this, request, ...rest);
    };
}

/* eslint-disable @typescript-eslint/no-require-imports */
export function loadApp() {
    installAppAlias();
    return {
        db: require(path.join(APP_SRC, 'db', 'index.ts')).default,
        ensureDatabaseReady: require(path.join(APP_SRC, 'db', 'index.ts')).ensureDatabaseReady,
        files: require(path.join(APP_SRC, 'db', 'files.ts')),
        inbox: require(path.join(APP_SRC, 'db', 'inbox.ts')),
        analytics: require(path.join(APP_SRC, 'lib', 'analytics.ts')),
        audit: require(path.join(APP_SRC, 'lib', 'AuditLogger.ts')),
        credit: require(path.join(APP_SRC, 'lib', 'SovereignCredit.ts')),
        accessEvents: require(path.join(APP_SRC, 'lib', 'accessEvents.ts')),
    };
}
/* eslint-enable @typescript-eslint/no-require-imports */

async function waitFor(cond: () => boolean, ms = 8000) {
    const end = Date.now() + ms;
    while (!cond()) {
        if (Date.now() > end) throw new Error('timeout waiting for condition');
        await new Promise((r) => setTimeout(r, 50));
    }
}

/** Runs every query path once; throws (assert) on any mismatch. Returns the expected backend name for logging. */
export async function runQueryPathScenario(expectBackend: 'postgres' | 'local'): Promise<void> {
    const app = loadApp();
    const { db } = app;
    assert.equal(await app.ensureDatabaseReady(), expectBackend);
    const now = Date.now();
    const u1 = randomUUID();
    const u2 = randomUUID();
    const email = `Alice-${u1.slice(0, 8)}@Example.com`;

    // users: credentials sign-up (src/lib/auth/credentials.ts, used by src/lib/auth/options.ts)
    await db.query(
        'INSERT INTO users (id, name, email, password_hash, image, provider, role, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [u1, 'Alice', email, 'scrypt$x', null, 'credentials', 'user', now]
    );
    await db.query('INSERT INTO users (id, name, email, created_at, username) VALUES ($1, $2, $3, $4, $5)', [u2, 'Bob', `bob-${u2}@x.io`, now, `bob_${u2.slice(0, 6)}`]);
    assert.equal((await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0].id, u1);
    assert.equal((await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [email.toLowerCase()])).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM users WHERE id = $1', [u1])).rows[0].role, 'user');
    assert.equal((await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', ['scrypt$y', u1])).rowCount, 1);
    await db.query('UPDATE users SET current_challenge = $1 WHERE id = $2', ['chal', u1]);
    await db.query('UPDATE users SET current_challenge = NULL WHERE id = $1', [u1]);
    assert.equal((await db.query('SELECT * FROM users WHERE id = $1', [u1])).rows[0].current_challenge, null);

    // webauthn (src/app/api/auth/webauthn/*)
    const credId = `cred-${u1}`;
    await db.query(`
        INSERT INTO webauthn_credentials (id, user_id, public_key, counter, device_type, backed_up, transports)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [credId, u1, Buffer.from([1, 2, 3]), 0, 'singleDevice', false, JSON.stringify(['usb'])]);
    assert.equal((await db.query('SELECT id, transports FROM webauthn_credentials WHERE user_id = $1', [u1])).rows.length, 1);
    assert.equal((await db.query('SELECT id FROM webauthn_credentials WHERE user_id = $1', [u1])).rows[0].id, credId);
    await db.query('UPDATE webauthn_credentials SET counter = $1 WHERE id = $2', [5, credId]);
    const cred = (await db.query('SELECT * FROM webauthn_credentials WHERE id = $1 AND user_id = $2', [credId, u1])).rows[0];
    assert.equal(Number(cred.counter), 5);
    assert.ok(Buffer.isBuffer(cred.public_key) && cred.public_key.length === 3);

    // files (src/db/files.ts)
    const { FileRepository, ChunkRepository, VariantRepository, SwarmNodeRepository } = app.files;
    const shareId = `s-${u1.slice(0, 12)}`;
    const created = await FileRepository.create({
        user_id: u1, share_id: shareId, original_name: 'Quarterly Report.pdf', sanitized_name: 'quarterly_report.pdf',
        storage_path: '/x/a.bin', file_size: 1234, mime_type: 'application/pdf', expires_at: now - 1,
        compression_ratio: '1.0x', compression_speed: '0ms', tags: ['finance', 'q3'], summary: 'numbers', is_encrypted: 1,
        encryption_iv: 'iv==',
    });
    const f = await FileRepository.findByShareId(shareId);
    assert.equal(f.id, created.id);
    assert.equal(Number(f.downloads), 0);
    assert.equal(Number(f.file_size), 1234);
    await FileRepository.setReactorMeta(shareId, 'text/json', '{"r":1}');
    assert.equal((await FileRepository.findByShareId(shareId)).reactor_class, 'text/json');
    assert.equal((await FileRepository.searchFiles(u1, 'finance')).length, 1);
    assert.equal((await FileRepository.searchFiles(u1, 'quarterly')).length, 1);
    assert.equal((await FileRepository.searchFiles(u1, 'nomatch')).length, 0);
    assert.equal((await FileRepository.findByUserId(u1)).length, 1);
    await FileRepository.incrementDownloads(shareId);
    assert.equal(Number((await FileRepository.findByShareId(shareId)).downloads), 1);
    assert.equal(await FileRepository.relocateStorage(shareId, '/wrong', 'reactor:abc', '2.0x'), false);
    assert.equal(await FileRepository.relocateStorage(shareId, '/x/a.bin', 'reactor:abc', '2.0x'), true);
    assert.ok((await FileRepository.findExpired(now)).some((r: { share_id: string }) => r.share_id === shareId));
    assert.ok((await FileRepository.listAll()).length >= 1);
    assert.equal((await db.query('SELECT user_id FROM files WHERE share_id = $1', [shareId])).rows[0].user_id, u1);

    // chunks / variants / swarm
    const chunkId = `c-${u1}`;
    await ChunkRepository.create({ id: chunkId, original_size: 10, hash: `h-${u1}` });
    await ChunkRepository.create({ id: `c2-${u1}`, original_size: 10, hash: `h-${u1}` }); // ON CONFLICT DO NOTHING
    assert.ok(await ChunkRepository.findById(chunkId));
    await VariantRepository.create({ id: `v-${u1}`, chunkId, algorithm: 'zstd', settings: { level: 3 }, quality: 1, fitness: { ratio: 2 }, data: Buffer.from('abc') });
    assert.equal((await VariantRepository.findByChunkId(chunkId))[0].settings.level, 3);
    const node = `n-${u1}`;
    await SwarmNodeRepository.pulse(node, 'eu', '10.0.0.1');
    await SwarmNodeRepository.pulse(node, 'eu', '10.0.0.1');
    assert.ok((await SwarmNodeRepository.getActive()).some((r: { id: string }) => r.id === node));
    await SwarmNodeRepository.markOffline(node);
    assert.ok(!(await SwarmNodeRepository.getActive()).some((r: { id: string }) => r.id === node));

    // analytics (src/lib/analytics.ts)
    await app.analytics.AnalyticsService.record({ fileId: created.id, eventType: 'view', ipAddress: '1.2.3.4' });
    await app.analytics.AnalyticsService.record({ fileId: created.id, eventType: 'download' });
    const stats = await app.analytics.AnalyticsService.getStats();
    assert.ok(stats.totalFiles >= 1 && stats.totalDownloads >= 2);
    assert.ok(stats.recentEvents.some((e: { original_name: string }) => e.original_name === 'Quarterly Report.pdf'));

    // audit log: free-text details (0002 made the column TEXT; JSONB rejected these inserts)
    const before = (await db.query('SELECT * FROM audit_logs ORDER BY timestamp ASC')).rows.length;
    await app.audit.AuditLogger.record({ userId: u1, action: 'FILE_VIEW', resource: shareId, details: 'Viewed shared file' });
    await new Promise((r) => setTimeout(r, 2));
    await app.audit.AuditLogger.record({ action: 'LOGIN', resource: u1, details: 'User signed in via credentials' });
    assert.equal((await db.query('SELECT * FROM audit_logs ORDER BY timestamp ASC')).rows.length, before + 2);
    assert.equal(await app.audit.AuditLogger.verifyChain(), true);

    // credits (src/lib/SovereignCredit.ts)
    const { SovereignCredit } = app.credit;
    await SovereignCredit.earn(u1, 10);
    await SovereignCredit.earn(u1, 5);
    assert.equal(await SovereignCredit.getBalance(u1), 15);
    assert.equal(await SovereignCredit.spend(u1, 4, 'priority'), true);
    assert.equal(await SovereignCredit.spend(u1, 400, 'priority'), false);
    assert.equal(await SovereignCredit.getBalance(u1), 11);

    // inbox (src/db/inbox.ts) — file_id holds the share_id
    const { InboxRepository } = app.inbox;
    const bobHandle = `bob_${u2.slice(0, 6)}`;
    assert.equal((await InboxRepository.resolveHandle(`@${bobHandle}`)).id, u2);
    assert.ok((await InboxRepository.searchHandles(bobHandle.slice(0, 5))).some((h: { id: string }) => h.id === u2));
    const item = await InboxRepository.send(u1, u2, shareId, 'hi');
    assert.equal(await InboxRepository.countPending(u2), 1);
    const list = await InboxRepository.findByRecipient(u2);
    assert.equal(list[0].original_name, 'Quarterly Report.pdf');
    assert.equal(list[0].sender_name, 'Alice');
    assert.equal((await InboxRepository.updateStatus(item.id, u2, 'accepted')).rowCount, 1);
    assert.equal(await InboxRepository.countPending(u2), 0);

    // spaces (src/app/api/spaces/**, SQL verbatim)
    const spaceId = randomUUID();
    const slug = `team-${spaceId.slice(0, 8)}`;
    await db.query(`
    INSERT INTO spaces (id, owner_id, name, slug, description, is_public, created_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [spaceId, u1, 'Team', slug, null, 0, now]);
    await db.query(`INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)`, [spaceId, u1, now]);
    await db.query(`INSERT INTO space_members (space_id, user_id, role, joined_at) VALUES ($1, $2, 'member', $3)`, [spaceId, u2, now]);
    for (let i = 0; i < 2; i++) {
        await db.query(`
    INSERT INTO space_files (space_id, file_id, uploaded_by, uploaded_at)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (space_id, file_id) DO UPDATE SET uploaded_at = EXCLUDED.uploaded_at, uploaded_by = EXCLUDED.uploaded_by
  `, [spaceId, shareId, u1, now + i]);
    }
    assert.equal((await db.query(`SELECT * FROM spaces WHERE owner_id = $1 ORDER BY created_at DESC`, [u1])).rows.length, 1);
    const memberOf = await db.query(`
    SELECT s.* FROM spaces s
    JOIN space_members sm ON sm.space_id = s.id
    WHERE sm.user_id = $1 AND s.owner_id != $2
    ORDER BY s.created_at DESC
  `, [u2, u2]);
    assert.equal(memberOf.rows[0].slug, slug);
    assert.equal((await db.query('SELECT * FROM spaces WHERE slug = $1', [slug])).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM spaces WHERE slug = $1 AND owner_id = $2', [slug, u1])).rows.length, 1);
    assert.equal((await db.query('SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2', [spaceId, u2])).rows.length, 1);
    const members = await db.query(`
    SELECT u.id, u.name, u.image, u.username, sm.role
    FROM space_members sm JOIN users u ON u.id = sm.user_id
    WHERE sm.space_id = $1
  `, [spaceId]);
    assert.equal(members.rows.length, 2);
    const spaceFiles = await db.query(`
    SELECT f.*, sf.uploaded_at, sf.uploaded_by, u.name AS uploader_name
    FROM space_files sf
    JOIN files f ON f.share_id = sf.file_id
    JOIN users u ON u.id = sf.uploaded_by
    WHERE sf.space_id = $1
    ORDER BY sf.uploaded_at DESC
  `, [spaceId]);
    assert.equal(spaceFiles.rows.length, 1);
    assert.equal(Number(spaceFiles.rows[0].uploaded_at), now + 1);
    assert.equal(spaceFiles.rows[0].uploader_name, 'Alice');
    assert.equal((await db.query('DELETE FROM space_files WHERE space_id = $1 AND file_id = $2 AND uploaded_by = $3', [spaceId, shareId, u1])).rowCount, 1);
    await db.query('DELETE FROM space_files WHERE space_id = $1', [spaceId]);
    await db.query('DELETE FROM space_members WHERE space_id = $1', [spaceId]);
    assert.equal((await db.query('DELETE FROM spaces WHERE id = $1', [spaceId])).rowCount, 1);

    // lobby / qr (src/app/api/lobby/**, src/app/api/qr/**)
    const code = `L${u1.slice(0, 5)}`;
    await db.query(`
      INSERT INTO lobby_sessions (id, code, creator_id, status, created_at, expires_at)
      VALUES ($1, $2, $3, 'waiting', $4, $5)
    `, [randomUUID(), code, u1, now, now + 60_000]);
    assert.equal((await db.query('SELECT * FROM lobby_sessions WHERE code = $1', [code])).rows[0].status, 'waiting');
    await db.query('UPDATE lobby_sessions SET joiner_id = $1, status = $2 WHERE code = $3', [u2, 'paired', code]);
    await db.query("UPDATE lobby_sessions SET status = 'complete' WHERE code = $1", [code]);
    assert.equal((await db.query('SELECT * FROM lobby_sessions WHERE code = $1', [code])).rows[0].status, 'complete');
    const qrId = randomUUID();
    await db.query(`
      INSERT INTO qr_sessions (id, creator_id, status, file_ids, created_at, expires_at)
      VALUES ($1, $2, 'waiting', $3, $4, $5)
    `, [qrId, null, JSON.stringify([shareId]), now, now + 300_000]);
    await db.query('UPDATE qr_sessions SET status = $1 WHERE id = $2', ['scanned', qrId]);
    assert.equal((await db.query('SELECT * FROM qr_sessions WHERE id = $1', [qrId])).rows[0].status, 'scanned');

    // access events (src/lib/accessEvents.ts): batched multi-row insert, load, prune
    const ae = app.accessEvents;
    const writtenBefore = ae.accessEventStats().written;
    for (let i = 0; i < 3; i++) ae.enqueueAccessEvent({ file_id: shareId, ts: now - i, actor: `u:${u1}` });
    await waitFor(() => ae.accessEventStats().written >= writtenBefore + 3 || ae.accessEventStats().writeErrors > 0);
    assert.equal(ae.accessEventStats().writeErrors, 0, String(ae.accessEventStats().lastError));
    const recent = await ae.loadRecentAccessEvents(now + 1);
    assert.ok(recent.filter((r: { file_id: string }) => r.file_id === shareId).length >= 3);
    assert.ok((await ae.pruneAccessEvents(now)) >= 0);

    // expired-file cleanup path: deleting a file that has analytics rows (0002: ON DELETE CASCADE)
    await FileRepository.delete(created.id);
    assert.equal(await FileRepository.findByShareId(shareId), undefined);
}
