import fs from 'fs';
import crypto from 'crypto';

const CHUNK_SIZE = 1024 * 1024; // 1 MiB

/**
 * Best-effort overwrite-then-delete.
 *
 * Overwrites the file contents in fixed-size chunks (zeros, ones, random) and then unlinks it.
 * HONEST CAVEAT: on SSDs/NVMe (wear levelling), copy-on-write or journaling filesystems,
 * cloud volumes and anything with snapshots/backups, in-place overwrites are NOT guaranteed to
 * touch the physical blocks that held the data. This reduces trivial recovery from simple
 * spinning-disk setups only; it is not a forensic guarantee. Use full-disk encryption for that.
 */
export async function secureDelete(filePath: string, passes: number = 3): Promise<void> {
    let handle: fs.promises.FileHandle | null = null;
    try {
        handle = await fs.promises.open(filePath, 'r+');
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw e;
    }

    try {
        const { size } = await handle.stat();
        const patterns: Array<(buf: Buffer) => void> = [
            (buf) => buf.fill(0x00),
            (buf) => buf.fill(0xff),
            (buf) => crypto.randomFillSync(buf),
        ];
        const buf = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, Math.max(size, 1)));

        for (let pass = 0; pass < Math.min(passes, patterns.length); pass++) {
            const fillStatic = pass < 2;
            if (fillStatic) patterns[pass](buf);
            for (let offset = 0; offset < size; offset += buf.length) {
                const len = Math.min(buf.length, size - offset);
                if (!fillStatic) patterns[pass](buf);
                await handle.write(buf, 0, len, offset);
            }
            await handle.datasync();
        }
    } finally {
        await handle.close();
    }

    await fs.promises.rm(filePath, { force: true });
    console.log(`[SHREDDER] Overwrote and deleted ${filePath} (best effort).`);
}
