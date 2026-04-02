import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

interface LedgerEntry {
    index: number;
    timestamp: number;
    fileHash: string;
    prevHash: string;
    signature: string;
    metadata: any;
}

const LEDGER_PATH = path.join(process.cwd(), 'data', 'merkle.log');

export const LedgerService = {
    record: async (fileBuffer: Buffer, metadata: any) => {
        try {
            const dir = path.dirname(LEDGER_PATH);
            if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });

            let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
            let index = 0;

            if (fs.existsSync(LEDGER_PATH)) {
                const content = await fs.promises.readFile(LEDGER_PATH, 'utf-8');
                const logs = content.trim().split('\n');
                if (logs.length > 0) {
                    const lastLine = logs[logs.length - 1];
                    try {
                        const lastEntry = JSON.parse(lastLine);
                        prevHash = createHash('sha256').update(JSON.stringify(lastEntry)).digest('hex');
                        index = lastEntry.index + 1;
                    } catch (e) { }
                }
            }

            const fileHash = createHash('sha256').update(fileBuffer).digest('hex');

            const entry: LedgerEntry = {
                index,
                timestamp: Date.now(),
                fileHash,
                prevHash,
                signature: `SIG_${createHash('sha256').update(`${index}:${fileHash}`).digest('hex').substring(0, 16)}`,
                metadata
            };

            await fs.promises.appendFile(LEDGER_PATH, JSON.stringify(entry) + '\n');
            console.log(`[LEDGER] Block #${index} mined.`);

            return entry;

        } catch (e) {
            console.error('[LEDGER] Failed to record:', e);
            return null;
        }
    },

    getRecentBlocks: async (limit = 10) => {
        if (!fs.existsSync(LEDGER_PATH)) return [];
        try {
            const content = await fs.promises.readFile(LEDGER_PATH, 'utf-8');
            const trimmed = content.trim();
            if (!trimmed) return [];
            return trimmed.split('\n').map(l => JSON.parse(l)).reverse().slice(0, limit);
        } catch (e) {
            return [];
        }
    }
}
