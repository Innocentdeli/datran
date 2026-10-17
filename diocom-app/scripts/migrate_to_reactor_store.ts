/**
 * Moves locally stored uploads into the reactor chunked object store (core-reactor/docs/NETWORK_SPEC.md §2).
 *
 * For each file record whose bytes are on local disk:
 *   1. read the stored object; legacy reactor/TS-compressed blobs are decoded first (same decoder as /api/stream),
 *      so the store sees plaintext and can chunk/dedup/compress it with evolved recipes;
 *   2. PUT /store/files (x-reactor-no-sample for password-protected / client-encrypted files);
 *   3. verify: returned file_id == SHA-256(plaintext), then a full GET read-back hashes to the same value;
 *   4. compare-and-set the record to storage_path = "reactor:<file_id>" (only if it still points at the old path);
 *   5. delete the local copy (only after 3 and 4 succeeded; --keep-local skips this).
 *
 * Resumable: progress is journaled (JSON lines) so a crash after the PUT reuses that pin instead of pinning twice, and
 * a crash after the DB update but before the local delete finishes the delete on the next run. Records already on
 * the store, on S3, expired, or with missing/out-of-root files are skipped. Thumbnails are not moved.
 *
 * With the local JSON DB (no DATABASE_URL), stop the app first: both processes would rewrite the same JSON file.
 *
 * Usage (from diocom-app/):
 *   TS_NODE_PROJECT=../tsconfig.json node --env-file-if-exists=.env.local \
 *     -r ../node_modules/ts-node/register/transpile-only scripts/migrate_to_reactor_store.ts [--dry-run]
 *     [--limit N] [--keep-local] [--include-expired] [--journal PATH]
 * Env: REACTOR_URL / REACTOR_PORT, REACTOR_TOKEN, DATABASE_URL or LOCAL_DB_PATH, DIOCOM_STORAGE_PATH.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { FileRepository, FileRecord } from '../src/db/files';
import { resolveStoredPath } from '../src/lib/storage';
import { putStoreFile, readStoreFile, deleteStoreFile, getStoreFile } from '../src/lib/storage/reactorStore';
import { parseReactorStoragePath, toReactorStoragePath, formatStoreRatio } from '../src/lib/storage/reactorStoreCore';
import { decompressPayload } from '../src/lib/reactorWorker';

interface Args { dryRun: boolean; limit: number; keepLocal: boolean; includeExpired: boolean; journal: string }

function parseArgs(argv: string[]): Args {
    const a: Args = {
        dryRun: false, limit: Infinity, keepLocal: false, includeExpired: false,
        journal: path.resolve(process.cwd(), 'data', 'migrate_to_reactor_store.journal.jsonl'),
    };
    for (let i = 0; i < argv.length; i++) {
        const v = argv[i];
        if (v === '--dry-run') a.dryRun = true;
        else if (v === '--keep-local') a.keepLocal = true;
        else if (v === '--include-expired') a.includeExpired = true;
        else if (v === '--limit') a.limit = Math.max(0, parseInt(argv[++i] || '', 10) || 0);
        else if (v === '--journal') a.journal = path.resolve(argv[++i] || a.journal);
        else if (v === '--help' || v === '-h') { console.log('see header of scripts/migrate_to_reactor_store.ts'); process.exit(0); }
        else { console.error(`Unknown argument: ${v}`); process.exit(2); }
    }
    return a;
}

/** Same rule as src/lib/streamCache.ts isCompressedRecord (kept local: that module uses Next.js path aliases). */
function isCompressedRecord(r: Pick<FileRecord, 'compression_ratio'>): boolean {
    return !!(r.compression_ratio && r.compression_ratio !== '1.0x' && r.compression_ratio !== '1.0x (Fast-path)');
}

type JournalState = 'put' | 'committed' | 'local_deleted';
interface JournalEntry { share_id: string; file_id: string; old_path: string; state: JournalState; ts: number }

function loadJournal(file: string): Map<string, JournalEntry> {
    const m = new Map<string, JournalEntry>();
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return m; }
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const e = JSON.parse(line) as JournalEntry;
            if (e && typeof e.share_id === 'string') m.set(e.share_id, e);
        } catch { /* torn last line after a crash */ }
    }
    return m;
}

/**
 * Exit without process.exit() racing open fetch sockets (libuv asserts on Windows); a Postgres pool would keep the
 * loop alive, so an unref'd timer forces the exit if the process doesn't end on its own.
 */
function finish(code: number) {
    process.exitCode = code;
    setTimeout(() => process.exit(code), 2_000).unref();
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function storeHashOf(fileId: string): Promise<string | null> {
    const data = await readStoreFile(fileId, Number.MAX_SAFE_INTEGER);
    return data ? sha256(data) : null;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const journal = loadJournal(args.journal);
    const write = (e: Omit<JournalEntry, 'ts'>) => {
        const full = { ...e, ts: Date.now() };
        journal.set(e.share_id, full);
        if (!args.dryRun) {
            fs.mkdirSync(path.dirname(args.journal), { recursive: true });
            fs.appendFileSync(args.journal, JSON.stringify(full) + '\n');
        }
    };

    // Fail fast if the store is unreachable or disabled (a 404 for an unknown id means it's up).
    const probe = await getStoreFile('0'.repeat(64)).catch((e) => { throw new Error(`Reactor store unreachable: ${e.message}`); });
    await probe.body?.cancel().catch(() => { });
    if (probe.status === 401 || probe.status === 403) throw new Error('Reactor rejected REACTOR_TOKEN');
    if (probe.status === 503) throw new Error('Reactor object store is disabled');

    const records = await FileRepository.listAll();
    const counts: Record<string, number> = {};
    const bump = (k: string) => { counts[k] = (counts[k] || 0) + 1; };
    let processed = 0;
    let movedBytes = 0;
    console.log(`[migrate] ${records.length} file records; ${args.dryRun ? 'DRY RUN' : 'live'}; journal ${args.journal}`);

    for (const rec of records) {
        if (processed >= args.limit) break;
        const tag = `${rec.share_id} (${rec.original_name})`;
        try {
            // Already migrated: finish an interrupted local delete if the journal says so.
            const existingId = parseReactorStoragePath(rec.storage_path);
            if (existingId) {
                const j = journal.get(rec.share_id);
                if (j && j.state === 'committed' && j.file_id === existingId && !args.keepLocal) {
                    const old = resolveStoredPath(j.old_path);
                    if (old && fs.existsSync(old)) {
                        if (args.dryRun) { console.log(`[migrate] would finish local delete for ${tag}`); bump('would_finish_delete'); continue; }
                        if ((await storeHashOf(existingId)) !== existingId) throw new Error('store copy failed verification; local copy kept');
                        await fs.promises.rm(old, { force: true });
                        write({ share_id: rec.share_id, file_id: existingId, old_path: j.old_path, state: 'local_deleted' });
                        console.log(`[migrate] finished local delete for ${tag}`);
                        bump('finished_delete');
                        continue;
                    }
                }
                bump('already_in_store');
                continue;
            }
            if (Number(rec.is_external) === 1 || /^https?:\/\//i.test(rec.storage_path || '')) { bump('skipped_s3'); continue; }
            if (!args.includeExpired && rec.expires_at && Date.now() > Number(rec.expires_at)) { bump('skipped_expired'); continue; }
            const filePath = resolveStoredPath(rec.storage_path);
            if (!filePath) { console.warn(`[migrate] ${tag}: stored path outside storage root, skipped`); bump('skipped_bad_path'); continue; }
            let disk: Buffer;
            try { disk = await fs.promises.readFile(filePath); } catch { console.warn(`[migrate] ${tag}: local file missing, skipped`); bump('skipped_missing'); continue; }

            processed++;
            const plain = isCompressedRecord(rec) ? (await decompressPayload(disk)).data : disk;
            if (Number(rec.file_size) && plain.length !== Number(rec.file_size)) {
                console.warn(`[migrate] ${tag}: decoded size ${plain.length} != recorded ${rec.file_size}; skipped`);
                bump('skipped_size_mismatch');
                continue;
            }
            const hash = sha256(plain);
            if (args.dryRun) {
                console.log(`[migrate] would move ${tag}: ${disk.length}B on disk${isCompressedRecord(rec) ? ' (compressed)' : ''} -> ${plain.length}B plaintext, sha256 ${hash.slice(0, 16)}…`);
                bump('would_move');
                movedBytes += plain.length;
                continue;
            }

            // PUT, unless a previous run already pinned exactly this content for this record.
            const prior = journal.get(rec.share_id);
            let ratio: string | null = null;
            let cls: string | null = null;
            if (prior && prior.state === 'put' && prior.file_id === hash && prior.old_path === rec.storage_path) {
                console.log(`[migrate] ${tag}: resuming (already pinned in store)`);
            } else {
                const put = await putStoreFile(new Uint8Array(plain.buffer as ArrayBuffer, plain.byteOffset, plain.byteLength), {
                    contentType: rec.mime_type || undefined,
                    noSample: Number(rec.is_encrypted) === 1 || !!rec.password_hash,
                });
                if (put.file_id !== hash || put.size !== plain.length) {
                    await deleteStoreFile(put.file_id).catch(() => { });
                    throw new Error(`store returned ${put.file_id}/${put.size}, expected ${hash}/${plain.length}`);
                }
                write({ share_id: rec.share_id, file_id: hash, old_path: rec.storage_path, state: 'put' });
                ratio = formatStoreRatio(put);
                cls = put.class;
            }

            // Verify by full read-back.
            const back = await storeHashOf(hash);
            if (back !== hash) {
                await deleteStoreFile(hash).catch(() => { });
                throw new Error(`read-back verification failed (${back ?? 'missing'}); store pin released, local copy kept`);
            }

            const ok = await FileRepository.relocateStorage(rec.share_id, rec.storage_path, toReactorStoragePath(hash), ratio ?? 'store');
            if (!ok) {
                await deleteStoreFile(hash).catch(() => { });
                console.warn(`[migrate] ${tag}: record changed or deleted during migration; store pin released`);
                bump('skipped_changed');
                continue;
            }
            write({ share_id: rec.share_id, file_id: hash, old_path: rec.storage_path, state: 'committed' });
            if (cls) await FileRepository.setReactorMeta(rec.share_id, cls, null);

            if (!args.keepLocal) {
                await fs.promises.rm(filePath, { force: true });
                write({ share_id: rec.share_id, file_id: hash, old_path: rec.storage_path, state: 'local_deleted' });
            }
            movedBytes += plain.length;
            bump('moved');
            console.log(`[migrate] moved ${tag} -> reactor:${hash.slice(0, 16)}… (${plain.length}B)${args.keepLocal ? ' [local kept]' : ''}`);
        } catch (e) {
            bump('failed');
            console.error(`[migrate] ${tag}: FAILED: ${e instanceof Error ? e.message : e}`);
        }
    }

    console.log(`[migrate] done: ${JSON.stringify(counts)}; ${(movedBytes / (1024 * 1024)).toFixed(2)} MiB ${args.dryRun ? 'would move' : 'moved'}`);
    finish(counts.failed ? 1 : 0);
}

main().catch((e) => {
    console.error('[migrate] fatal:', e instanceof Error ? e.message : e);
    finish(1);
});
