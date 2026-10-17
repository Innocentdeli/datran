import { Pool, type PoolClient } from 'pg';
import fs from 'fs';
import path from 'path';

const connectionString = process.env.DATABASE_URL;

type Row = Record<string, unknown>;
type QueryRows = { rows: Row[]; rowCount: number | null };
type LocalClient = { query: (text: string, params?: unknown[]) => Promise<QueryRows>; release: () => void };
type TableMap = Record<string, Row[]>;

const TABLE_NAMES = [
    'users',
    'files',
    'analytics',
    'chunks',
    'variants',
    'swarm_nodes',
    'webauthn_credentials',
    'audit_logs',
    'user_credits',
    'credit_ledger',
    'inboxes',
    'spaces',
    'space_members',
    'space_files',
    'lobby_sessions',
    'qr_sessions',
    'access_events',
];

/**
 * Local JSON DB location. Deliberately kept OUTSIDE the upload storage directory
 * so that uploaded files can never overwrite it.
 */
function resolveLocalDbPath(): string {
    const dbPath = path.resolve(process.cwd(), process.env.LOCAL_DB_PATH || './data/local_db.json');
    const storageDir = path.resolve(process.cwd(), process.env.DIOCOM_STORAGE_PATH || './.storage');
    const rel = path.relative(storageDir, dbPath);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
        throw new Error('[DB-Local] LOCAL_DB_PATH must not be inside the upload storage directory (DIOCOM_STORAGE_PATH).');
    }
    return dbPath;
}

/** One-time move of the old <storage>/local_db.json to the new location. */
function migrateLegacyLocalDb(target: string) {
    try {
        const storageDir = path.resolve(process.cwd(), process.env.DIOCOM_STORAGE_PATH || './.storage');
        const legacy = path.join(storageDir, 'local_db.json');
        if (!fs.existsSync(target) && fs.existsSync(legacy)) {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.copyFileSync(legacy, target);
            fs.unlinkSync(legacy); // do not leave user data inside the upload dir
            console.info(`[DB-Local] Migrated legacy local DB from ${legacy} to ${target}`);
        }
    } catch (err) {
        console.warn('[DB-Local] Legacy local DB migration skipped:', (err as Error).message);
    }
}

class LocalPersistentStore {
    private dbFilePath: string;
    private tables: TableMap = {};

    constructor() {
        this.dbFilePath = resolveLocalDbPath();
        migrateLegacyLocalDb(this.dbFilePath);
        this.load();
    }

    private load() {
        for (const t of TABLE_NAMES) {
            if (!this.tables[t]) this.tables[t] = [];
        }
        try {
            if (fs.existsSync(this.dbFilePath)) {
                const raw = fs.readFileSync(this.dbFilePath, 'utf8');
                const parsed = JSON.parse(raw, (_k, v) => {
                    if (v && typeof v === 'object' && v.__type === 'Buffer' && typeof v.data === 'string') {
                        return Buffer.from(v.data, 'base64');
                    }
                    return v;
                });
                for (const t of TABLE_NAMES) {
                    if (Array.isArray(parsed[t])) {
                        this.tables[t] = parsed[t];
                    }
                }
            }
        } catch (err) {
            console.warn('[DB-Local] Starting with fresh local state:', (err as Error).message);
        }
    }

    private save() {
        try {
            fs.mkdirSync(path.dirname(this.dbFilePath), { recursive: true });
            const serialized = JSON.stringify(this.tables, (_k, v) => {
                if (Buffer.isBuffer(v)) {
                    return { __type: 'Buffer', data: v.toString('base64') };
                }
                if (v && v.type === 'Buffer' && Array.isArray(v.data)) {
                    return { __type: 'Buffer', data: Buffer.from(v.data).toString('base64') };
                }
                return v;
            }, 2);
            fs.writeFileSync(this.dbFilePath, serialized, 'utf8');
        } catch (err) {
            console.error('[DB-Local] Failed to persist local DB:', (err as Error).message);
        }
    }

    private resolveValue(token: string, params: unknown[]): unknown {
        const trimmed = token.trim();
        if (trimmed.startsWith('$')) {
            const idx = parseInt(trimmed.slice(1), 10) - 1;
            return params[idx];
        }
        if (trimmed === '?') {
            return params[0];
        }
        if (trimmed.toUpperCase() === 'NULL') return null;
        if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
            return trimmed.slice(1, -1);
        }
        const num = Number(trimmed);
        if (!Number.isNaN(num)) return num;
        return trimmed;
    }

    public async query(sqlText: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
        this.load();
        const sql = sqlText.replace(/\s+/g, ' ').trim();
        const upper = sql.toUpperCase();

        // 1. DDL / Transactions
        if (
            upper === 'BEGIN' ||
            upper === 'COMMIT' ||
            upper === 'ROLLBACK' ||
            upper.startsWith('CREATE TABLE') ||
            upper.startsWith('CREATE INDEX') ||
            upper.startsWith('ALTER TABLE') // JSON rows are schemaless; added columns are simply absent until set
        ) {
            return { rows: [], rowCount: 0 };
        }

        // 2a. Batched access events (src/lib/accessEvents.ts): multi-row VALUES, params in (file_id, ts, actor) triples
        if (upper.startsWith('INSERT INTO ACCESS_EVENTS')) {
            const n = Math.floor(params.length / 3);
            for (let i = 0; i < n; i++) {
                this.tables.access_events.push({ file_id: params[i * 3], ts: Number(params[i * 3 + 1]), actor: params[i * 3 + 2] });
            }
            this.save();
            return { rows: [], rowCount: n };
        }

        // 2. INSERT INTO <table> (<cols>) VALUES (<vals>)
        const insertMatch = sql.match(/^INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(.*)$/i);
        if (insertMatch) {
            const table = insertMatch[1].toLowerCase();
            const cols = insertMatch[2].split(',').map(c => c.trim());
            const valTokens = insertMatch[3].split(',').map(v => v.trim());
            const conflictClause = (insertMatch[4] || '').trim().toUpperCase();

            if (!this.tables[table]) this.tables[table] = [];
            const newRow: Row = {};
            cols.forEach((col, i) => {
                newRow[col] = this.resolveValue(valTokens[i], params);
            });

            // Defaults based on schema
            if (table === 'files') {
                if (newRow.downloads === undefined) newRow.downloads = 0;
                if (newRow.last_accessed_at === undefined) newRow.last_accessed_at = null;
            }

            if (conflictClause.includes('ON CONFLICT')) {
                if (table === 'chunks' && conflictClause.includes('DO NOTHING')) {
                    const exists = this.tables.chunks.find(r => r.hash === newRow.hash || r.id === newRow.id);
                    if (exists) return { rows: [], rowCount: 0 };
                } else if (table === 'swarm_nodes') {
                    const existing = this.tables.swarm_nodes.find(r => r.id === newRow.id);
                    if (existing) {
                        existing.last_pulse = newRow.last_pulse;
                        existing.status = 'active';
                        this.save();
                        return { rows: [existing], rowCount: 1 };
                    }
                } else if (table === 'user_credits') {
                    const existing = this.tables.user_credits.find(r => r.user_id === newRow.user_id);
                    if (existing) {
                        existing.balance = Number(existing.balance || 0) + Number(newRow.balance || 0);
                        existing.total_earned = Number(existing.total_earned || 0) + Number(newRow.total_earned || 0);
                        existing.last_updated = newRow.last_updated;
                        this.save();
                        return { rows: [existing], rowCount: 1 };
                    }
                }
            }

            this.tables[table].push(newRow);
            this.save();
            return { rows: [newRow], rowCount: 1 };
        }

        // 3. UPDATE queries
        if (upper.startsWith('UPDATE ')) {
            let count = 0;
            if (upper.startsWith('UPDATE FILES SET DOWNLOADS = DOWNLOADS + 1')) {
                const ts = params[0];
                const key = params[1];
                for (const r of this.tables.files) {
                    if (r.share_id === key || r.id === key) {
                        r.downloads = Number(r.downloads || 0) + 1;
                        r.last_accessed_at = ts;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE FILES SET LAST_ACCESSED_AT')) {
                const ts = params[0];
                const id = params[1];
                for (const r of this.tables.files) {
                    if (r.id === id) {
                        r.last_accessed_at = ts;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE FILES SET STORAGE_PATH')) {
                // Compare-and-set relocation (scripts/migrate_to_reactor_store.ts)
                const [storagePath, ratio, shareId, expectedPath] = params;
                for (const r of this.tables.files) {
                    if (r.share_id === shareId && r.storage_path === expectedPath) {
                        r.storage_path = storagePath;
                        r.compression_ratio = ratio ?? null;
                        r.is_external = 0;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE FILES SET REACTOR_CLASS')) {
                const [reactorClass, reactorRecipe, shareId] = params;
                for (const r of this.tables.files) {
                    if (r.share_id === shareId) {
                        r.reactor_class = reactorClass ?? null;
                        r.reactor_recipe = reactorRecipe ?? null;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE SWARM_NODES SET STATUS')) {
                const id = params[0];
                for (const r of this.tables.swarm_nodes) {
                    if (r.id === id) {
                        r.status = 'offline';
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE INBOXES SET STATUS')) {
                const [status, id, recipientId] = params;
                for (const r of this.tables.inboxes) {
                    if (r.id === id && r.recipient_id === recipientId) {
                        r.status = status;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE USER_CREDITS SET BALANCE')) {
                const [amt, spentAmt, ts, userId] = params;
                for (const r of this.tables.user_credits) {
                    if (r.user_id === userId) {
                        r.balance = Number(r.balance || 0) - Number(amt);
                        r.total_spent = Number(r.total_spent || 0) + Number(spentAmt);
                        r.last_updated = ts;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE USERS SET PASSWORD_HASH')) {
                const [hash, userId] = params;
                for (const r of this.tables.users) {
                    if (r.id === userId) {
                        r.password_hash = hash;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE USERS SET CURRENT_CHALLENGE = NULL')) {
                const userId = params[0];
                for (const r of this.tables.users) {
                    if (r.id === userId) {
                        r.current_challenge = null;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE USERS SET CURRENT_CHALLENGE')) {
                const [challenge, userId] = params;
                for (const r of this.tables.users) {
                    if (r.id === userId) {
                        r.current_challenge = challenge;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE WEBAUTHN_CREDENTIALS SET COUNTER')) {
                const [counter, id] = params;
                for (const r of this.tables.webauthn_credentials) {
                    if (r.id === id) {
                        r.counter = counter;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE LOBBY_SESSIONS SET JOINER_ID')) {
                const [joinerId, status, code] = params;
                for (const r of this.tables.lobby_sessions) {
                    if (r.code === code) {
                        r.joiner_id = joinerId;
                        r.status = status;
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE LOBBY_SESSIONS SET STATUS')) {
                const [code] = params;
                for (const r of this.tables.lobby_sessions) {
                    if (r.code === code) {
                        r.status = 'complete';
                        count++;
                    }
                }
            } else if (upper.startsWith('UPDATE QR_SESSIONS SET STATUS')) {
                const [status, id] = params;
                for (const r of this.tables.qr_sessions) {
                    if (r.id === id) {
                        r.status = status;
                        count++;
                    }
                }
            }
            this.save();
            return { rows: [], rowCount: count };
        }

        // 4. DELETE queries
        if (upper.startsWith('DELETE FROM ')) {
            let before = 0;
            let after = 0;
            if (upper.startsWith('DELETE FROM ACCESS_EVENTS WHERE TS < $1')) {
                before = this.tables.access_events.length;
                this.tables.access_events = this.tables.access_events.filter(r => Number(r.ts) >= Number(params[0]));
                after = this.tables.access_events.length;
            } else if (upper.startsWith('DELETE FROM FILES WHERE ID')) {
                before = this.tables.files.length;
                this.tables.files = this.tables.files.filter(r => r.id !== params[0]);
                after = this.tables.files.length;
            } else if (upper.startsWith('DELETE FROM SPACE_FILES WHERE SPACE_ID = $1 AND FILE_ID = $2')) {
                before = this.tables.space_files.length;
                this.tables.space_files = this.tables.space_files.filter(
                    r => !(r.space_id === params[0] && r.file_id === params[1] && r.uploaded_by === params[2])
                );
                after = this.tables.space_files.length;
            } else if (upper.startsWith('DELETE FROM SPACE_FILES WHERE SPACE_ID')) {
                before = this.tables.space_files.length;
                this.tables.space_files = this.tables.space_files.filter(r => r.space_id !== params[0]);
                after = this.tables.space_files.length;
            } else if (upper.startsWith('DELETE FROM SPACE_MEMBERS WHERE SPACE_ID')) {
                before = this.tables.space_members.length;
                this.tables.space_members = this.tables.space_members.filter(r => r.space_id !== params[0]);
                after = this.tables.space_members.length;
            } else if (upper.startsWith('DELETE FROM SPACES WHERE ID')) {
                before = this.tables.spaces.length;
                this.tables.spaces = this.tables.spaces.filter(r => r.id !== params[0]);
                after = this.tables.spaces.length;
            }
            this.save();
            return { rows: [], rowCount: before - after };
        }

        // 5. SELECT queries
        if (upper.startsWith('SELECT ')) {
            if (upper.includes('FROM ACCESS_EVENTS WHERE TS >= $1 ORDER BY TS DESC LIMIT $2')) {
                const rows = this.tables.access_events
                    .filter(r => Number(r.ts) >= Number(params[0]))
                    .sort((a, b) => Number(b.ts) - Number(a.ts))
                    .slice(0, Math.max(0, Number(params[1]) || 0));
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM ACCESS_EVENTS ORDER BY TS DESC LIMIT 1 OFFSET $1')) {
                const sorted = [...this.tables.access_events].sort((a, b) => Number(b.ts) - Number(a.ts));
                const row = sorted[Number(params[0]) || 0];
                return { rows: row ? [{ ts: row.ts }] : [], rowCount: row ? 1 : 0 };
            }
            if (upper.includes('FROM FILES ORDER BY CREATED_AT ASC')) {
                const rows = [...this.tables.files].sort((a, b) => Number(a.created_at) - Number(b.created_at));
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM FILES WHERE SHARE_ID = $1')) {
                const rows = this.tables.files.filter(r => r.share_id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM FILES WHERE EXPIRES_AT < $1')) {
                const rows = this.tables.files.filter(r => r.expires_at && Number(r.expires_at) < Number(params[0]));
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM FILES WHERE USER_ID = $1 AND')) {
                const userId = params[0];
                const needle = String(params[1] || '').replace(/%/g, '').toLowerCase();
                const rows = this.tables.files
                    .filter(r => r.user_id === userId)
                    .filter(r =>
                        String(r.original_name || '').toLowerCase().includes(needle) ||
                        String(r.tags || '').toLowerCase().includes(needle) ||
                        String(r.summary || '').toLowerCase().includes(needle)
                    )
                    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM FILES WHERE USER_ID = $1')) {
                const rows = this.tables.files
                    .filter(r => r.user_id === params[0])
                    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('SELECT COUNT(*) AS COUNT FROM FILES')) {
                return { rows: [{ count: String(this.tables.files.length) }], rowCount: 1 };
            }
            if (upper.includes('SELECT SUM(DOWNLOADS) AS COUNT FROM FILES')) {
                const sum = this.tables.files.reduce((acc, r) => acc + Number(r.downloads || 0), 0);
                return { rows: [{ count: String(sum) }], rowCount: 1 };
            }
            if (upper.includes('SELECT SUM(FILE_SIZE) AS SIZE FROM FILES')) {
                const sum = this.tables.files.reduce((acc, r) => acc + Number(r.file_size || 0), 0);
                return { rows: [{ size: String(sum) }], rowCount: 1 };
            }
            if (upper.includes('FROM ANALYTICS A')) {
                const rows = [...this.tables.analytics]
                    .sort((a, b) => Number(b.timestamp) - Number(a.timestamp))
                    .slice(0, 50)
                    .map(a => {
                        const f = this.tables.files.find(file => file.id === a.file_id);
                        return { ...a, original_name: f?.original_name || null };
                    });
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM CHUNKS WHERE ID = $1')) {
                const rows = this.tables.chunks.filter(r => r.id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM VARIANTS WHERE CHUNK_ID = $1')) {
                const rows = this.tables.variants.filter(r => r.chunk_id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM SWARM_NODES WHERE LAST_PULSE > $1')) {
                const rows = this.tables.swarm_nodes.filter(
                    r => Number(r.last_pulse) > Number(params[0]) && r.status === 'active'
                );
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM AUDIT_LOGS ORDER BY TIMESTAMP DESC LIMIT 1')) {
                const sorted = [...this.tables.audit_logs].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
                return { rows: sorted.length ? [{ hash: sorted[0].hash }] : [], rowCount: sorted.length ? 1 : 0 };
            }
            if (upper.includes('FROM AUDIT_LOGS ORDER BY TIMESTAMP ASC')) {
                const sorted = [...this.tables.audit_logs].sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
                return { rows: sorted, rowCount: sorted.length };
            }
            if (upper.includes('FROM USER_CREDITS WHERE USER_ID = $1')) {
                const rows = this.tables.user_credits.filter(r => r.user_id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM USERS WHERE EMAIL = $1')) {
                const rows = this.tables.users.filter(r => r.email === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM USERS WHERE ID = $1')) {
                const rows = this.tables.users.filter(r => r.id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM USERS WHERE USERNAME = $1')) {
                const rows = this.tables.users.filter(r => r.username === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM USERS WHERE USERNAME ILIKE $1')) {
                const needle = String(params[0] || '').replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
                const rows = this.tables.users
                    .filter(r => r.username &&String(r.username).toLowerCase().includes(needle))
                    .slice(0, 10);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('SELECT COUNT(*) AS COUNT FROM INBOXES')) {
                const count = this.tables.inboxes.filter(
                    r => r.recipient_id === params[0] && r.status === 'pending'
                ).length;
                return { rows: [{ count: String(count) }], rowCount: 1 };
            }
            if (upper.includes('FROM INBOXES I')) {
                const rows = this.tables.inboxes
                    .filter(i => i.recipient_id === params[0])
                    .sort((a, b) => Number(b.created_at) - Number(a.created_at))
                    .map(i => {
                        const u = this.tables.users.find(user => user.id === i.sender_id);
                        const f = this.tables.files.find(file => file.share_id === i.file_id);
                        return {
                            ...i,
                            sender_name: u?.name || null,
                            sender_image: u?.image || null,
                            sender_username: u?.username || null,
                            original_name: f?.original_name || null,
                            file_size: f?.file_size || null,
                            mime_type: f?.mime_type || null,
                            share_id: f?.share_id || i.file_id,
                        };
                    });
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM WEBAUTHN_CREDENTIALS WHERE ID = $1 AND USER_ID = $2')) {
                const rows = this.tables.webauthn_credentials.filter(
                    r => r.id === params[0] && r.user_id === params[1]
                );
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM WEBAUTHN_CREDENTIALS WHERE USER_ID = $1')) {
                const rows = this.tables.webauthn_credentials.filter(r => r.user_id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM LOBBY_SESSIONS WHERE CODE = $1')) {
                const rows = this.tables.lobby_sessions.filter(r => r.code === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM QR_SESSIONS WHERE ID = $1')) {
                const rows = this.tables.qr_sessions.filter(r => r.id === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM SPACES WHERE OWNER_ID = $1')) {
                const rows = this.tables.spaces
                    .filter(r => r.owner_id === params[0])
                    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM SPACES S JOIN SPACE_MEMBERS SM')) {
                const userId = params[0];
                const memberSpaceIds = new Set(
                    this.tables.space_members.filter(sm => sm.user_id === userId).map(sm => sm.space_id)
                );
                const rows = this.tables.spaces
                    .filter(s => memberSpaceIds.has(s.id) && s.owner_id !== userId)
                    .sort((a, b) => Number(b.created_at) - Number(a.created_at));
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM SPACES WHERE SLUG = $1 AND OWNER_ID = $2')) {
                const rows = this.tables.spaces.filter(r => r.slug === params[0] && r.owner_id === params[1]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM SPACES WHERE SLUG = $1')) {
                const rows = this.tables.spaces.filter(r => r.slug === params[0]);
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('SELECT 1 FROM SPACE_MEMBERS WHERE SPACE_ID = $1 AND USER_ID = $2')) {
                const rows = this.tables.space_members.filter(
                    r => r.space_id === params[0] && r.user_id === params[1]
                );
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM SPACE_MEMBERS SM JOIN USERS U')) {
                const rows = this.tables.space_members
                    .filter(sm => sm.space_id === params[0])
                    .map(sm => {
                        const u = this.tables.users.find(user => user.id === sm.user_id);
                        return {
                            id: u?.id || sm.user_id,
                            name: u?.name || null,
                            email: u?.email || null,
                            image: u?.image || null,
                            role: sm.role,
                            joined_at: sm.joined_at,
                        };
                    });
                return { rows, rowCount: rows.length };
            }
            if (upper.includes('FROM SPACE_FILES SF')) {
                const rows = this.tables.space_files
                    .filter(sf => sf.space_id === params[0])
                    .sort((a, b) => Number(b.uploaded_at) - Number(a.uploaded_at))
                    .map(sf => {
                        const f = this.tables.files.find(
                            file => file.share_id === sf.file_id || file.id === sf.file_id
                        );
                        const u = this.tables.users.find(user => user.id === sf.uploaded_by);
                        return {
                            ...(f || {}),
                            uploader_name: u?.name || null,
                            uploaded_at: sf.uploaded_at,
                        };
                    });
                return { rows, rowCount: rows.length };
            }
        }

        return { rows: [], rowCount: 0 };
    }

    public async connect(): Promise<LocalClient> {
        return {
            query: (text: string, params?: unknown[]) => this.query(text, params),
            release: () => { },
        };
    }
}

type Backend = 'postgres' | 'local';

/**
 * Backend selection happens ONCE:
 *  - DATABASE_URL unset                      -> local JSON store
 *  - DATABASE_URL set, startup probe fails   -> local JSON store (dev), or hard failure in
 *                                               production unless DB_ALLOW_LOCAL_FALLBACK=true
 *  - DATABASE_URL set, probe succeeds        -> PostgreSQL; later query errors are thrown
 *                                               to the caller (never silently re-routed)
 */
class HybridDatabasePool {
    private pgPool: Pool | null = null;
    private localStore: LocalPersistentStore | null = null;
    private backendPromise: Promise<Backend> | null = null;

    constructor() {
        if (connectionString) {
            this.pgPool = new Pool({
                connectionString,
                max: 20,
                idleTimeoutMillis: 30000,
                connectionTimeoutMillis: 5000,
            });
            // Prevent idle-client errors from crashing the process
            this.pgPool.on('error', (err) => {
                console.error('[DB] PostgreSQL idle client error:', err.message);
            });
        }
    }

    private getLocalStore(): LocalPersistentStore {
        if (!this.localStore) this.localStore = new LocalPersistentStore();
        return this.localStore;
    }

    private resolveBackend(): Promise<Backend> {
        if (!this.backendPromise) {
            this.backendPromise = (async (): Promise<Backend> => {
                if (!this.pgPool) {
                    console.info(`[DB] Active backend: LOCAL JSON store (${resolveLocalDbPath()}) — DATABASE_URL not set.`);
                    return 'local';
                }
                try {
                    await this.pgPool.query('SELECT 1');
                    console.info('[DB] Active backend: PostgreSQL.');
                    return 'postgres';
                } catch (err) {
                    const allowFallback =
                        process.env.NODE_ENV !== 'production' || process.env.DB_ALLOW_LOCAL_FALLBACK === 'true';
                    if (!allowFallback) {
                        console.error('[DB] PostgreSQL unreachable at startup and local fallback is disabled in production:', (err as Error).message);
                        // Allow a retry on the next request rather than caching the failure forever
                        this.backendPromise = null;
                        throw new Error('Database unavailable');
                    }
                    console.error(
                        `[DB] PostgreSQL unreachable at startup (${(err as Error).message}). ` +
                        `Active backend: LOCAL JSON store (${resolveLocalDbPath()}).`
                    );
                    await this.pgPool.end().catch(() => { });
                    this.pgPool = null;
                    return 'local';
                }
            })();
        }
        return this.backendPromise;
    }

    public async query(text: string, params?: unknown[]): Promise<QueryRows> {
        const backend = await this.resolveBackend();
        if (backend === 'postgres' && this.pgPool) {
            // Errors (constraint violations, syntax, transient network) propagate to the caller
            return this.pgPool.query(text, params);
        }
        return this.getLocalStore().query(text, params);
    }

    public async connect(): Promise<PoolClient | LocalClient> {
        const backend = await this.resolveBackend();
        if (backend === 'postgres' && this.pgPool) {
            return this.pgPool.connect();
        }
        return this.getLocalStore().connect();
    }
}

if (!global.diocomHybridPool) {
    global.diocomHybridPool = new HybridDatabasePool() as unknown as Pool;
}
const pool = global.diocomHybridPool;

export default pool as Pool;

declare global {
    var diocomHybridPool: Pool | undefined;
}
