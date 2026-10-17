/**
 * DEVELOPMENT/TEST-ONLY JSON emulator of the PostgreSQL schema (migrations/*.sql). Never used in production
 * (src/db/index.ts refuses to start there without a reachable PostgreSQL).
 *
 * It does not parse SQL. Every statement the app sends must be registered below, either as an exact shape
 * (whitespace/case-insensitive match of the whole statement) or as a generic INSERT into a known table. Anything
 * else throws UnsupportedLocalQueryError, so a new or edited query fails loudly in dev instead of silently
 * returning no rows. When you add or change a query in the app, add/adjust its shape here.
 *
 * Limitations: no real transactions (BEGIN/COMMIT/ROLLBACK are no-ops), no constraint checks beyond the
 * ON CONFLICT handling registered per table, column projections are not applied (rows come back whole).
 */
import fs from 'fs';
import path from 'path';

export type Row = Record<string, unknown>;
export type QueryResult = { rows: Row[]; rowCount: number };
type Tables = Record<string, Row[]>;
type Handler = (t: Tables, p: unknown[]) => QueryResult;

export class UnsupportedLocalQueryError extends Error {
    constructor(sql: string) {
        super(
            `[DB-Local] Query not supported by the dev JSON store (src/db/localStore.ts). Register its shape there, or ` +
            `run against PostgreSQL (DATABASE_URL). Statement: ${sql.slice(0, 300)}`
        );
        this.name = 'UnsupportedLocalQueryError';
    }
}

export const TABLE_NAMES = [
    'users', 'files', 'analytics', 'chunks', 'variants', 'swarm_nodes', 'webauthn_credentials', 'audit_logs',
    'user_credits', 'credit_ledger', 'inboxes', 'spaces', 'space_members', 'space_files', 'lobby_sessions',
    'qr_sessions', 'access_events',
] as const;

/** Column defaults from migrations/0001_initial.sql (applied to INSERTs that omit the column). */
const DEFAULTS: Record<string, Row> = {
    users: { role: 'user' },
    files: { is_external: 0, downloads: 0, is_encrypted: 0, last_accessed_at: null, reactor_class: null, reactor_recipe: null },
    swarm_nodes: { status: 'active' },
    user_credits: { balance: 0, total_earned: 0, total_spent: 0 },
    inboxes: { status: 'pending' },
    spaces: { is_public: 0 },
    space_members: { role: 'member' },
    lobby_sessions: { status: 'waiting' },
    qr_sessions: { status: 'waiting' },
};

/** Primary keys (for duplicate detection on plain INSERT). */
const PRIMARY_KEYS: Record<string, string[]> = {
    user_credits: ['user_id'],
    space_members: ['space_id', 'user_id'],
    space_files: ['space_id', 'file_id'],
    access_events: [],
};

/** Whitespace/case-insensitive canonical form used for matching. */
export function normalizeSql(sql: string): string {
    return sql
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\s+,/g, ',')
        .trim()
        .replace(/;$/, '')
        .toUpperCase();
}

const num = (v: unknown) => Number(v ?? 0);
const byDesc = (k: string) => (a: Row, b: Row) => num(b[k]) - num(a[k]);
const byAsc = (k: string) => (a: Row, b: Row) => num(a[k]) - num(b[k]);
const rows = (r: Row[]): QueryResult => ({ rows: r, rowCount: r.length });
const pick = (r: Row, cols: string[]): Row => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]));
/** UPDATE helper: applies `fn` to every row matching `where`, returns rowCount. */
function update(list: Row[], where: (r: Row) => boolean, fn: (r: Row) => void): QueryResult {
    let n = 0;
    for (const r of list) if (where(r)) { fn(r); n++; }
    return { rows: [], rowCount: n };
}
/** DELETE helper: mutates the table in place. */
function remove(t: Tables, table: string, where: (r: Row) => boolean): QueryResult {
    const before = t[table].length;
    t[table] = t[table].filter((r) => !where(r));
    return { rows: [], rowCount: before - t[table].length };
}
/** ILIKE '%needle%' with backslash escapes, as built by the callers. */
function ilikeContains(value: unknown, pattern: unknown): boolean {
    const needle = String(pattern ?? '').replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase();
    return String(value ?? '').toLowerCase().includes(needle);
}
function tagsText(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

/** Exact statement shapes, keyed by the SQL exactly as written in the app (normalised on registration). */
const EXACT: [string, Handler][] = [
    // --- users ---
    ['SELECT * FROM users WHERE email = $1', (t, p) => rows(t.users.filter((r) => r.email === p[0]))],
    ['SELECT * FROM users WHERE LOWER(email) = $1', (t, p) => rows(t.users.filter((r) => String(r.email ?? '').toLowerCase() === p[0]))],
    ['SELECT * FROM users WHERE id = $1', (t, p) => rows(t.users.filter((r) => r.id === p[0]))],
    ['SELECT id, name, username FROM users WHERE username = $1',
        (t, p) => rows(t.users.filter((r) => r.username === p[0]).map((r) => pick(r, ['id', 'name', 'username'])))],
    ['SELECT id, name, username, image FROM users WHERE username ILIKE $1 AND username IS NOT NULL LIMIT 10',
        (t, p) => rows(t.users.filter((r) => r.username != null && ilikeContains(r.username, p[0])).slice(0, 10)
            .map((r) => pick(r, ['id', 'name', 'username', 'image'])))],
    ['UPDATE users SET password_hash = $1 WHERE id = $2', (t, p) => update(t.users, (r) => r.id === p[1], (r) => { r.password_hash = p[0]; })],
    ['UPDATE users SET current_challenge = $1 WHERE id = $2', (t, p) => update(t.users, (r) => r.id === p[1], (r) => { r.current_challenge = p[0]; })],
    ['UPDATE users SET current_challenge = NULL WHERE id = $1', (t, p) => update(t.users, (r) => r.id === p[0], (r) => { r.current_challenge = null; })],

    // --- webauthn ---
    ['SELECT id, transports FROM webauthn_credentials WHERE user_id = $1',
        (t, p) => rows(t.webauthn_credentials.filter((r) => r.user_id === p[0]).map((r) => pick(r, ['id', 'transports'])))],
    ['SELECT id FROM webauthn_credentials WHERE user_id = $1',
        (t, p) => rows(t.webauthn_credentials.filter((r) => r.user_id === p[0]).map((r) => pick(r, ['id'])))],
    ['SELECT * FROM webauthn_credentials WHERE id = $1 AND user_id = $2',
        (t, p) => rows(t.webauthn_credentials.filter((r) => r.id === p[0] && r.user_id === p[1]))],
    ['UPDATE webauthn_credentials SET counter = $1 WHERE id = $2',
        (t, p) => update(t.webauthn_credentials, (r) => r.id === p[1], (r) => { r.counter = p[0]; })],

    // --- files ---
    ['SELECT * FROM files ORDER BY created_at ASC', (t) => rows([...t.files].sort(byAsc('created_at')))],
    ['SELECT * FROM files WHERE share_id = $1', (t, p) => rows(t.files.filter((r) => r.share_id === p[0]))],
    ['SELECT user_id FROM files WHERE share_id = $1', (t, p) => rows(t.files.filter((r) => r.share_id === p[0]).map((r) => pick(r, ['user_id'])))],
    ['SELECT * FROM files WHERE expires_at < $1', (t, p) => rows(t.files.filter((r) => r.expires_at != null && num(r.expires_at) < num(p[0])))],
    ['SELECT * FROM files WHERE user_id = $1 ORDER BY created_at DESC', (t, p) => rows(t.files.filter((r) => r.user_id === p[0]).sort(byDesc('created_at')))],
    ['SELECT * FROM files WHERE user_id = $1 AND (original_name ILIKE $2 OR CAST(tags AS TEXT) ILIKE $2 OR summary ILIKE $2) ORDER BY created_at DESC',
        (t, p) => rows(t.files
            .filter((r) => r.user_id === p[0])
            .filter((r) => ilikeContains(r.original_name, p[1]) || ilikeContains(tagsText(r.tags), p[1]) || ilikeContains(r.summary, p[1]))
            .sort(byDesc('created_at')))],
    ['UPDATE files SET reactor_class = $1, reactor_recipe = $2 WHERE share_id = $3',
        (t, p) => update(t.files, (r) => r.share_id === p[2], (r) => { r.reactor_class = p[0] ?? null; r.reactor_recipe = p[1] ?? null; })],
    ['UPDATE files SET storage_path = $1, compression_ratio = $2, is_external = 0 WHERE share_id = $3 AND storage_path = $4',
        (t, p) => update(t.files, (r) => r.share_id === p[2] && r.storage_path === p[3],
            (r) => { r.storage_path = p[0]; r.compression_ratio = p[1] ?? null; r.is_external = 0; })],
    ['UPDATE files SET downloads = downloads + 1, last_accessed_at = $1 WHERE share_id = $2',
        (t, p) => update(t.files, (r) => r.share_id === p[1], (r) => { r.downloads = num(r.downloads) + 1; r.last_accessed_at = p[0]; })],
    ['UPDATE files SET downloads = downloads + 1, last_accessed_at = $1 WHERE id = $2',
        (t, p) => update(t.files, (r) => r.id === p[1], (r) => { r.downloads = num(r.downloads) + 1; r.last_accessed_at = p[0]; })],
    ['UPDATE files SET last_accessed_at = $1 WHERE id = $2',
        (t, p) => update(t.files, (r) => r.id === p[1], (r) => { r.last_accessed_at = p[0]; })],
    ['DELETE FROM files WHERE id = $1', (t, p) => {
        remove(t, 'analytics', (r) => r.file_id === p[0]); // ON DELETE CASCADE (0002)
        return remove(t, 'files', (r) => r.id === p[0]);
    }],
    ['SELECT COUNT(*) as count FROM files', (t) => rows([{ count: String(t.files.length) }])],
    ['SELECT SUM(downloads) as count FROM files',
        (t) => rows([{ count: t.files.length ? String(t.files.reduce((a, r) => a + num(r.downloads), 0)) : null }])],
    ['SELECT SUM(file_size) as size FROM files',
        (t) => rows([{ size: t.files.length ? String(t.files.reduce((a, r) => a + num(r.file_size), 0)) : null }])],

    // --- analytics ---
    ['SELECT a.*, f.original_name FROM analytics a LEFT JOIN files f ON a.file_id = f.id ORDER BY timestamp DESC LIMIT 50',
        (t) => rows([...t.analytics].sort(byDesc('timestamp')).slice(0, 50)
            .map((a) => ({ ...a, original_name: t.files.find((f) => f.id === a.file_id)?.original_name ?? null })))],

    // --- chunks / variants / swarm ---
    ['SELECT * FROM chunks WHERE id = $1', (t, p) => rows(t.chunks.filter((r) => r.id === p[0]))],
    ['SELECT * FROM variants WHERE chunk_id = $1', (t, p) => rows(t.variants.filter((r) => r.chunk_id === p[0]))],
    ["SELECT * FROM swarm_nodes WHERE last_pulse > $1 AND status = 'active'",
        (t, p) => rows(t.swarm_nodes.filter((r) => num(r.last_pulse) > num(p[0]) && r.status === 'active'))],
    ["UPDATE swarm_nodes SET status = 'offline' WHERE id = $1",
        (t, p) => update(t.swarm_nodes, (r) => r.id === p[0], (r) => { r.status = 'offline'; })],

    // --- audit / credits ---
    ['SELECT hash FROM audit_logs ORDER BY timestamp DESC LIMIT 1',
        (t) => rows([...t.audit_logs].sort(byDesc('timestamp')).slice(0, 1).map((r) => pick(r, ['hash'])))],
    ['SELECT * FROM audit_logs ORDER BY timestamp ASC', (t) => rows([...t.audit_logs].sort(byAsc('timestamp')))],
    ['SELECT balance FROM user_credits WHERE user_id = $1',
        (t, p) => rows(t.user_credits.filter((r) => r.user_id === p[0]).map((r) => pick(r, ['balance'])))],
    ['UPDATE user_credits SET balance = balance - $1, total_spent = total_spent + $2, last_updated = $3 WHERE user_id = $4',
        (t, p) => update(t.user_credits, (r) => r.user_id === p[3], (r) => {
            r.balance = num(r.balance) - num(p[0]);
            r.total_spent = num(r.total_spent) + num(p[1]);
            r.last_updated = p[2];
        })],

    // --- inbox ---
    ['SELECT i.*, u.name AS sender_name, u.image AS sender_image, u.username AS sender_username, f.original_name, f.file_size, f.mime_type, f.share_id FROM inboxes i LEFT JOIN users u ON u.id = i.sender_id LEFT JOIN files f ON f.share_id = i.file_id WHERE i.recipient_id = $1 ORDER BY i.created_at DESC',
        (t, p) => rows(t.inboxes.filter((i) => i.recipient_id === p[0]).sort(byDesc('created_at')).map((i) => {
            const u = t.users.find((x) => x.id === i.sender_id);
            const f = t.files.find((x) => x.share_id === i.file_id);
            return {
                ...i,
                sender_name: u?.name ?? null, sender_image: u?.image ?? null, sender_username: u?.username ?? null,
                original_name: f?.original_name ?? null, file_size: f?.file_size ?? null, mime_type: f?.mime_type ?? null,
                share_id: f?.share_id ?? null,
            };
        }))],
    ['UPDATE inboxes SET status = $1 WHERE id = $2 AND recipient_id = $3',
        (t, p) => update(t.inboxes, (r) => r.id === p[1] && r.recipient_id === p[2], (r) => { r.status = p[0]; })],
    ["SELECT COUNT(*) as count FROM inboxes WHERE recipient_id = $1 AND status = 'pending'",
        (t, p) => rows([{ count: String(t.inboxes.filter((r) => r.recipient_id === p[0] && r.status === 'pending').length) }])],

    // --- lobby / qr ---
    ['SELECT * FROM lobby_sessions WHERE code = $1', (t, p) => rows(t.lobby_sessions.filter((r) => r.code === p[0]))],
    ['UPDATE lobby_sessions SET joiner_id = $1, status = $2 WHERE code = $3',
        (t, p) => update(t.lobby_sessions, (r) => r.code === p[2], (r) => { r.joiner_id = p[0]; r.status = p[1]; })],
    ["UPDATE lobby_sessions SET status = 'complete' WHERE code = $1",
        (t, p) => update(t.lobby_sessions, (r) => r.code === p[0], (r) => { r.status = 'complete'; })],
    ['SELECT * FROM qr_sessions WHERE id = $1', (t, p) => rows(t.qr_sessions.filter((r) => r.id === p[0]))],
    ['UPDATE qr_sessions SET status = $1 WHERE id = $2', (t, p) => update(t.qr_sessions, (r) => r.id === p[1], (r) => { r.status = p[0]; })],

    // --- spaces ---
    ['SELECT * FROM spaces WHERE owner_id = $1 ORDER BY created_at DESC', (t, p) => rows(t.spaces.filter((r) => r.owner_id === p[0]).sort(byDesc('created_at')))],
    ['SELECT s.* FROM spaces s JOIN space_members sm ON sm.space_id = s.id WHERE sm.user_id = $1 AND s.owner_id != $2 ORDER BY s.created_at DESC',
        (t, p) => {
            const ids = new Set(t.space_members.filter((m) => m.user_id === p[0]).map((m) => m.space_id));
            return rows(t.spaces.filter((s) => ids.has(s.id) && s.owner_id !== p[1]).sort(byDesc('created_at')));
        }],
    ['SELECT * FROM spaces WHERE slug = $1', (t, p) => rows(t.spaces.filter((r) => r.slug === p[0]))],
    ['SELECT * FROM spaces WHERE slug = $1 AND owner_id = $2', (t, p) => rows(t.spaces.filter((r) => r.slug === p[0] && r.owner_id === p[1]))],
    ['SELECT 1 FROM space_members WHERE space_id = $1 AND user_id = $2',
        (t, p) => rows(t.space_members.filter((r) => r.space_id === p[0] && r.user_id === p[1]).map(() => ({ '?column?': 1 })))],
    ['SELECT u.id, u.name, u.image, u.username, sm.role FROM space_members sm JOIN users u ON u.id = sm.user_id WHERE sm.space_id = $1',
        (t, p) => rows(t.space_members.filter((m) => m.space_id === p[0]).flatMap((m) => {
            const u = t.users.find((x) => x.id === m.user_id);
            return u ? [{ id: u.id, name: u.name ?? null, image: u.image ?? null, username: u.username ?? null, role: m.role }] : [];
        }))],
    ['SELECT f.*, sf.uploaded_at, sf.uploaded_by, u.name AS uploader_name FROM space_files sf JOIN files f ON f.share_id = sf.file_id JOIN users u ON u.id = sf.uploaded_by WHERE sf.space_id = $1 ORDER BY sf.uploaded_at DESC',
        (t, p) => rows(t.space_files.filter((sf) => sf.space_id === p[0]).sort(byDesc('uploaded_at')).flatMap((sf) => {
            const f = t.files.find((x) => x.share_id === sf.file_id);
            const u = t.users.find((x) => x.id === sf.uploaded_by);
            return f && u ? [{ ...f, uploaded_at: sf.uploaded_at, uploaded_by: sf.uploaded_by, uploader_name: u.name ?? null }] : [];
        }))],
    ['DELETE FROM space_files WHERE space_id = $1 AND file_id = $2 AND uploaded_by = $3',
        (t, p) => remove(t, 'space_files', (r) => r.space_id === p[0] && r.file_id === p[1] && r.uploaded_by === p[2])],
    ['DELETE FROM space_files WHERE space_id = $1', (t, p) => remove(t, 'space_files', (r) => r.space_id === p[0])],
    ['DELETE FROM space_members WHERE space_id = $1', (t, p) => remove(t, 'space_members', (r) => r.space_id === p[0])],
    ['DELETE FROM spaces WHERE id = $1', (t, p) => remove(t, 'spaces', (r) => r.id === p[0])],

    // --- access events (src/lib/accessEvents.ts) ---
    ['SELECT file_id, ts, actor FROM access_events WHERE ts >= $1 ORDER BY ts DESC LIMIT $2',
        (t, p) => rows(t.access_events.filter((r) => num(r.ts) >= num(p[0])).sort(byDesc('ts')).slice(0, Math.max(0, num(p[1])))
            .map((r) => pick(r, ['file_id', 'ts', 'actor'])))],
    ['DELETE FROM access_events WHERE ts < $1', (t, p) => remove(t, 'access_events', (r) => num(r.ts) < num(p[0]))],
    ['SELECT ts FROM access_events ORDER BY ts DESC LIMIT 1 OFFSET $1', (t, p) => {
        const r = [...t.access_events].sort(byDesc('ts'))[num(p[0])];
        return rows(r ? [{ ts: r.ts }] : []);
    }],
];

const EXACT_MAP = new Map<string, Handler>(EXACT.map(([sql, h]) => [normalizeSql(sql), h]));

/** ON CONFLICT clauses supported per table (normalised), applied to the existing row. */
const CONFLICTS: Record<string, { clause: string; key: string[]; onConflict: (existing: Row, incoming: Row) => Row[] }[]> = {
    chunks: [{ clause: 'ON CONFLICT (HASH) DO NOTHING', key: ['hash'], onConflict: () => [] }],
    swarm_nodes: [{
        clause: "ON CONFLICT(ID) DO UPDATE SET LAST_PULSE = EXCLUDED.LAST_PULSE, STATUS = 'ACTIVE'", key: ['id'],
        onConflict: (e, n) => { e.last_pulse = n.last_pulse; e.status = 'active'; return [e]; },
    }],
    user_credits: [{
        clause: 'ON CONFLICT (USER_ID) DO UPDATE SET BALANCE = USER_CREDITS.BALANCE + EXCLUDED.BALANCE, TOTAL_EARNED = USER_CREDITS.TOTAL_EARNED + EXCLUDED.TOTAL_EARNED, LAST_UPDATED = EXCLUDED.LAST_UPDATED',
        key: ['user_id'],
        onConflict: (e, n) => {
            e.balance = num(e.balance) + num(n.balance);
            e.total_earned = num(e.total_earned) + num(n.total_earned);
            e.last_updated = n.last_updated;
            return [e];
        },
    }],
    space_files: [{
        clause: 'ON CONFLICT (SPACE_ID, FILE_ID) DO UPDATE SET UPLOADED_AT = EXCLUDED.UPLOADED_AT, UPLOADED_BY = EXCLUDED.UPLOADED_BY',
        key: ['space_id', 'file_id'],
        onConflict: (e, n) => { e.uploaded_at = n.uploaded_at; e.uploaded_by = n.uploaded_by; return [e]; },
    }],
};

const INSERT_RE = /^INSERT INTO (\w+) ?\(([^)]+)\) ?VALUES ?(.+?)(?: (ON CONFLICT.*))?$/;
const DDL_RE = /^(BEGIN|COMMIT|ROLLBACK|CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS)\b/;

/** Splits "VALUES ($1, $2, 'x'), ($3, ...)" into tuples of raw tokens (no commas/parentheses inside literals). */
function parseValueTuples(src: string): string[][] {
    const tuples: string[][] = [];
    const re = /\(([^()]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) tuples.push(m[1].split(',').map((s) => s.trim()));
    return tuples;
}

function resolveToken(token: string, original: string, params: unknown[]): unknown {
    const m = /^\$(\d+)$/.exec(token);
    if (m) return params[parseInt(m[1], 10) - 1];
    if (token === 'NULL') return null;
    if (/^'.*'$/.test(token)) return original.slice(1, -1); // keep the literal's original case
    if (/^-?\d+(\.\d+)?$/.test(token)) return Number(token);
    throw new Error(`unsupported VALUES token ${token}`);
}

export function resolveLocalDbPath(): string {
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

export class LocalPersistentStore {
    private tables: Tables = {};

    constructor(private readonly dbFilePath: string = resolveLocalDbPath()) {
        migrateLegacyLocalDb(this.dbFilePath);
        this.load();
    }

    private load() {
        const fresh: Tables = {};
        for (const t of TABLE_NAMES) fresh[t] = [];
        try {
            if (fs.existsSync(this.dbFilePath)) {
                const parsed = JSON.parse(fs.readFileSync(this.dbFilePath, 'utf8'), (_k, v) =>
                    v && typeof v === 'object' && v.__type === 'Buffer' && typeof v.data === 'string' ? Buffer.from(v.data, 'base64') : v
                );
                for (const t of TABLE_NAMES) if (Array.isArray(parsed[t])) fresh[t] = parsed[t];
            }
        } catch (err) {
            console.warn('[DB-Local] Starting with fresh local state:', (err as Error).message);
        }
        this.tables = fresh;
    }

    private save() {
        try {
            fs.mkdirSync(path.dirname(this.dbFilePath), { recursive: true });
            const serialized = JSON.stringify(this.tables, (_k, v) => {
                if (Buffer.isBuffer(v)) return { __type: 'Buffer', data: v.toString('base64') };
                if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { __type: 'Buffer', data: Buffer.from(v.data).toString('base64') };
                return v;
            }, 2);
            // Write-then-rename so a crash never leaves a truncated JSON file.
            const tmp = `${this.dbFilePath}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, serialized, 'utf8');
            fs.renameSync(tmp, this.dbFilePath);
        } catch (err) {
            console.error('[DB-Local] Failed to persist local DB:', (err as Error).message);
        }
    }

    private insert(sql: string, original: string, params: unknown[]): QueryResult | null {
        const m = INSERT_RE.exec(sql);
        if (!m) return null;
        const table = m[1].toLowerCase();
        if (!(TABLE_NAMES as readonly string[]).includes(table)) throw new UnsupportedLocalQueryError(original);
        const cols = m[2].split(',').map((c) => c.trim().toLowerCase());
        const conflict = m[4]?.trim();
        const rule = conflict ? CONFLICTS[table]?.find((c) => normalizeSql(c.clause) === conflict) : undefined;
        if (conflict && !rule) throw new UnsupportedLocalQueryError(original);

        // Literal case is lost by normalisation; recover literals from the original VALUES text by position.
        const origValues = /VALUES\s*([\s\S]+?)(\s+ON\s+CONFLICT[\s\S]*)?;?\s*$/i.exec(original.trim())?.[1] ?? '';
        const tuples = parseValueTuples(m[3]);
        const origTuples = parseValueTuples(origValues.replace(/\s+/g, ' '));
        if (!tuples.length || tuples.some((tp) => tp.length !== cols.length)) throw new UnsupportedLocalQueryError(original);

        const out: Row[] = [];
        let count = 0;
        tuples.forEach((tuple, ti) => {
            const row: Row = { ...(DEFAULTS[table] ?? {}) };
            cols.forEach((c, i) => { row[c] = resolveToken(tuple[i], origTuples[ti]?.[i] ?? tuple[i], params); });
            if (table === 'access_events') row.id = (this.tables.access_events.reduce((mx, r) => Math.max(mx, num(r.id)), 0) || 0) + 1;
            const key = rule?.key ?? PRIMARY_KEYS[table] ?? ['id'];
            const existing = key.length ? this.tables[table].find((r) => key.every((k) => r[k] === row[k])) : undefined;
            if (existing) {
                if (!rule) throw new Error(`[DB-Local] duplicate key value violates unique constraint on ${table} (${key.join(', ')})`);
                const res = rule.onConflict(existing, row);
                out.push(...res);
                count += res.length;
                return;
            }
            this.tables[table].push(row);
            out.push(row);
            count++;
        });
        return { rows: out, rowCount: count };
    }

    public async query(sqlText: string, params: unknown[] = []): Promise<QueryResult> {
        const sql = normalizeSql(sqlText);
        if (DDL_RE.test(sql) || /^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS\b/.test(sql)) {
            return { rows: [], rowCount: 0 }; // rows are schemaless; schema lives in migrations/
        }
        this.load();
        const handler = EXACT_MAP.get(sql);
        let result: QueryResult | null = null;
        if (handler) {
            result = handler(this.tables, params);
        } else if (sql.startsWith('INSERT INTO ')) {
            result = this.insert(sql, sqlText, params);
        }
        if (!result) throw new UnsupportedLocalQueryError(sqlText.replace(/\s+/g, ' ').trim());
        if (!sql.startsWith('SELECT ')) this.save();
        return result;
    }

    public async connect(): Promise<{ query: LocalPersistentStore['query']; release: () => void }> {
        return { query: (text, params) => this.query(text, params), release: () => { } };
    }
}

/** For tests: true when the statement has a registered shape (does not execute it). */
export function isSupportedLocalQuery(sqlText: string): boolean {
    const sql = normalizeSql(sqlText);
    return DDL_RE.test(sql) || EXACT_MAP.has(sql) || INSERT_RE.test(sql);
}
