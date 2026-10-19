import fs from 'fs';
import path from 'path';
import type { KV } from '../../kv/types';

/**
 * Staging storage for partial tus uploads (no Next.js / '@/' imports: unit-tested from the repo root).
 *
 *   <dir>/<id>.bin   the bytes received so far (written at explicit offsets under the per-upload lock)
 *   <dir>/<id>.json  the upload record (durable mirror; lets the expiry sweep enumerate uploads)
 *   KV tus:info:<id> the same record (primary copy; shared by all instances through Redis)
 *
 * Single node: any local directory. Several app instances: the directory must be shared storage (NFS, EFS, a shared
 * volume) because PATCHes for one upload may land on different instances; the KV lock serializes them.
 */

export type TusUploadState =
    /** Receiving bytes. */
    | 'uploading'
    /** All bytes received; finalize running (under the upload lock). */
    | 'finalizing'
    /** All bytes received; finalize failed with a retryable error (GET on the upload URL retries). */
    | 'complete'
    /** Finalized: `result` holds the share link. Kept for `resultRetentionMs`, data file already deleted. */
    | 'done'
    /** Finalize failed permanently: `error` holds the response. Data file already deleted. */
    | 'failed';

export interface TusStoredResponse {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
}

export interface TusUploadInfo {
    id: string;
    /** Upload-Length. */
    length: number;
    /** Bytes durably received. */
    offset: number;
    /** Upload-Metadata as accepted (sensitive keys such as `password` removed). */
    metadata: Record<string, string>;
    createdAt: number;
    /** Upload-Expires (epoch ms): refreshed on every PATCH; for done/failed records the result retention deadline. */
    expiresAt: number;
    state: TusUploadState;
    /** User id of the creator; null for anonymous uploads. */
    ownerId: string | null;
    /** Application data validated at creation (JSON). */
    context: Record<string, unknown>;
    /** Finalize result (state 'done'). */
    result?: TusStoredResponse;
    /** Last finalize error (state 'failed' or 'complete'). */
    error?: TusStoredResponse;
}

export const TUS_ID_RE = /^[A-Za-z0-9_-]{22,64}$/;
const KV_PREFIX = 'tus:info:';
/** Extra lifetime of the KV copy past expiresAt (the sweep removes the files). */
const KV_GRACE_MS = 60 * 60_000;

export interface FileWriter {
    write(chunk: Uint8Array): Promise<void>;
    /** Flushes buffered bytes to the file (the OS page cache; survives a process crash). */
    flush(): Promise<void>;
    close(): Promise<void>;
}

export class StagingStore {
    constructor(readonly dir: string, private readonly kv: KV | null = null) { }

    private check(id: string) {
        if (!TUS_ID_RE.test(id)) throw new Error('invalid upload id');
    }

    dataPath(id: string): string {
        this.check(id);
        return path.join(this.dir, `${id}.bin`);
    }

    private infoPath(id: string): string {
        this.check(id);
        return path.join(this.dir, `${id}.json`);
    }

    async create(info: TusUploadInfo): Promise<void> {
        await fs.promises.mkdir(this.dir, { recursive: true });
        const fh = await fs.promises.open(this.dataPath(info.id), 'wx');
        await fh.close();
        await this.saveInfo(info);
    }

    async saveInfo(info: TusUploadInfo): Promise<void> {
        const json = JSON.stringify(info);
        if (this.kv) {
            const ttl = Math.max(info.expiresAt - Date.now(), 60_000) + KV_GRACE_MS;
            await this.kv.set(KV_PREFIX + info.id, json, ttl);
        }
        const target = this.infoPath(info.id);
        const tmp = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.promises.writeFile(tmp, json);
        try {
            await fs.promises.rename(tmp, target);
        } catch {
            // Windows: the target may be open by a concurrent reader for a moment; retry once.
            await new Promise((r) => setTimeout(r, 20));
            await fs.promises.rename(tmp, target).catch(async (e) => {
                await fs.promises.rm(tmp, { force: true });
                throw e;
            });
        }
    }

    async loadInfo(id: string): Promise<TusUploadInfo | null> {
        if (!TUS_ID_RE.test(id)) return null;
        if (this.kv) {
            const raw = await this.kv.get(KV_PREFIX + id);
            if (raw) {
                try { return JSON.parse(raw) as TusUploadInfo; } catch { /* fall through to the sidecar */ }
            }
        }
        let raw: string;
        try {
            raw = await fs.promises.readFile(this.infoPath(id), 'utf8');
        } catch {
            return null;
        }
        let info: TusUploadInfo;
        try {
            info = JSON.parse(raw) as TusUploadInfo;
        } catch {
            return null;
        }
        if (this.kv) {
            // KV lost the record (memory KV restart, eviction): re-seed it from the durable copy.
            const ttl = Math.max(info.expiresAt - Date.now(), 60_000) + KV_GRACE_MS;
            await this.kv.set(KV_PREFIX + id, raw, ttl).catch(() => undefined);
        }
        return info;
    }

    /** Opens the data file for appending at `offset`; anything beyond `offset` (a crashed write) is cut off first. */
    async openWriter(id: string, offset: number, bufferBytes = 1024 * 1024): Promise<FileWriter> {
        const fh = await fs.promises.open(this.dataPath(id), 'r+');
        try {
            await fh.truncate(offset);
        } catch (e) {
            await fh.close();
            throw e;
        }
        let position = offset;
        let parts: Uint8Array[] = [];
        let pending = 0;
        const flush = async () => {
            if (!pending) return;
            const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, pending);
            parts = [];
            pending = 0;
            let done = 0;
            while (done < buf.length) {
                const { bytesWritten } = await fh.write(buf, done, buf.length - done, position);
                done += bytesWritten;
                position += bytesWritten;
            }
        };
        return {
            async write(chunk) {
                if (!chunk.length) return;
                parts.push(chunk);
                pending += chunk.length;
                if (pending >= bufferBytes) await flush();
            },
            flush,
            async close() {
                await fh.close();
            },
        };
    }

    async truncate(id: string, size: number): Promise<void> {
        await fs.promises.truncate(this.dataPath(id), size);
    }

    async dataSize(id: string): Promise<number | null> {
        try {
            return (await fs.promises.stat(this.dataPath(id))).size;
        } catch {
            return null;
        }
    }

    /** Deletes the bytes (finalized or failed upload); the record stays for the result retention period. */
    async removeData(id: string): Promise<void> {
        await fs.promises.rm(this.dataPath(id), { force: true });
    }

    /** Deletes everything about an upload. */
    async remove(id: string): Promise<void> {
        await fs.promises.rm(this.dataPath(id), { force: true });
        await fs.promises.rm(this.infoPath(id), { force: true });
        if (this.kv) await this.kv.del(KV_PREFIX + id);
    }

    /** Deletes a path returned by orphans() (only files directly inside the staging directory). */
    async removeOrphan(p: string): Promise<boolean> {
        if (path.dirname(path.resolve(p)) !== path.resolve(this.dir)) return false;
        try {
            await fs.promises.rm(p, { force: true });
            return true;
        } catch {
            return false;
        }
    }

    /** Ids of every upload with a record in the staging directory. */
    async listIds(): Promise<string[]> {
        let names: string[];
        try {
            names = await fs.promises.readdir(this.dir);
        } catch {
            return [];
        }
        return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => TUS_ID_RE.test(id));
    }

    /**
     * Data files without a record older than `graceMs` (a crash between creating the file and writing the record),
     * plus stray temp files. Returns the paths.
     */
    async orphans(now: number, graceMs: number): Promise<string[]> {
        let names: string[];
        try {
            names = await fs.promises.readdir(this.dir);
        } catch {
            return [];
        }
        const set = new Set(names);
        const out: string[] = [];
        for (const n of names) {
            const isBin = n.endsWith('.bin') && !set.has(`${n.slice(0, -4)}.json`);
            const isTmp = n.endsWith('.tmp');
            if (!isBin && !isTmp) continue;
            const p = path.join(this.dir, n);
            try {
                if (now - (await fs.promises.stat(p)).mtimeMs > graceMs) out.push(p);
            } catch { /* gone */ }
        }
        return out;
    }
}
