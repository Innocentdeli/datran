import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

/**
 * Append-only, hash-chained upload log.
 *
 * Each entry stores the SHA-256 of the uploaded file and the SHA-256 of the previous entry,
 * so tampering with an earlier line is detectable by re-hashing the chain. There are NO
 * cryptographic signatures and no consensus/mining: this is a local tamper-evident log only.
 */
interface LedgerEntry {
    index: number;
    timestamp: number;
    fileHash: string;
    prevHash: string;
    /** SHA-256 over index, timestamp, fileHash and prevHash (not a signature). */
    digest: string;
    metadata: unknown;
}

const LEDGER_PATH = path.join(process.cwd(), 'data', 'merkle.log');
const GENESIS_HASH = '0'.repeat(64);

let state: { nextIndex: number; prevHash: string } | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function loadState() {
    if (state) return state;
    let nextIndex = 0;
    let prevHash = GENESIS_HASH;
    try {
        const content = await fs.promises.readFile(LEDGER_PATH, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        const lastLine = lines[lines.length - 1];
        if (lastLine) {
            const lastEntry = JSON.parse(lastLine);
            prevHash = createHash('sha256').update(lastLine).digest('hex');
            nextIndex = (Number(lastEntry.index) || 0) + 1;
        }
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error('[LEDGER] Could not read existing log tail:', (e as Error).message);
            throw e;
        }
    }
    state = { nextIndex, prevHash };
    return state;
}

async function append(fileHash: string, metadata: unknown): Promise<LedgerEntry> {
    const s = await loadState();
    await fs.promises.mkdir(path.dirname(LEDGER_PATH), { recursive: true });

    const index = s.nextIndex;
    const timestamp = Date.now();
    const digest = createHash('sha256').update(`${index}:${timestamp}:${fileHash}:${s.prevHash}`).digest('hex');

    const entry: LedgerEntry = { index, timestamp, fileHash, prevHash: s.prevHash, digest, metadata };
    const line = JSON.stringify(entry);
    await fs.promises.appendFile(LEDGER_PATH, line + '\n');

    // Only advance in-memory state after a successful write.
    s.nextIndex = index + 1;
    s.prevHash = createHash('sha256').update(line).digest('hex');
    console.log(`[LEDGER] Appended entry #${index}.`);
    return entry;
}

export const LedgerService = {
    /** Appends are serialized through an in-process queue so concurrent uploads get distinct indices. */
    record: async (fileBuffer: Buffer, metadata: unknown): Promise<LedgerEntry | null> =>
        LedgerService.recordHash(createHash('sha256').update(fileBuffer).digest('hex'), metadata),

    /** Same as record() for a file whose SHA-256 (lowercase hex) was computed while streaming it. */
    recordHash: async (fileHash: string, metadata: unknown): Promise<LedgerEntry | null> => {
        if (!/^[0-9a-f]{64}$/.test(fileHash)) {
            console.error('[LEDGER] Failed to record: invalid file hash');
            return null;
        }
        const run = queue.then(() => append(fileHash, metadata));
        queue = run.catch(() => undefined);
        try {
            return await run;
        } catch (e) {
            console.error('[LEDGER] Failed to record:', e instanceof Error ? e.message : e);
            return null;
        }
    },

    getRecentBlocks: async (limit = 10) => {
        try {
            const content = await fs.promises.readFile(LEDGER_PATH, 'utf-8');
            const trimmed = content.trim();
            if (!trimmed) return [];
            const lines = trimmed.split('\n');
            return lines.slice(-limit).reverse().map(l => {
                try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
        } catch {
            return [];
        }
    }
}
