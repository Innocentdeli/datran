import db from './index';
import { randomUUID } from 'crypto';
import { DCE2_DB_MARKER } from '../lib/crypto/dce2';
import type { Variant } from '../../../src/core/types';

export interface FileRecord {
    id: string;
    user_id?: string | null;
    share_id: string;
    original_name: string;
    sanitized_name: string;
    storage_path: string;
    thumbnail_path?: string | null;
    password_hash?: string | null;
    is_external?: number;
    file_size: number;
    mime_type: string;
    created_at: number;
    expires_at: number | null;
    downloads: number;
    last_accessed_at: number | null;
    compression_ratio: string | null;
    compression_speed: string | null;
    tags?: string | null;
    summary?: string | null;
    is_encrypted: number;
    encryption_iv?: string | null;
    similarity_token?: string | null;
    /** Rust reactor content class (e.g. text/json); null for legacy/TS-compressed uploads. */
    reactor_class?: string | null;
    /** Compact recipe JSON the reactor used; null for legacy/TS-compressed uploads. */
    reactor_recipe?: string | null;
}

let reactorMetaWarned = false;

/**
 * Client-safe projection of a file record. Never exposes storage_path, thumbnail_path,
 * password_hash, user_id, similarity_token or the internal row id.
 * Use this for every file record that is sent to a browser (JSON responses, client component props).
 */
export interface PublicFile {
    share_id: string;
    original_name: string;
    file_size: number;
    mime_type: string;
    created_at: number;
    expires_at: number | null;
    downloads: number;
    compression_ratio: string | null;
    compression_speed: string | null;
    tags: unknown;
    summary: string | null;
    is_encrypted: number;
    encryption_iv: string | null;
    /** 'dce2' = chunked streaming format (encryption_iv holds the DCE2 marker), 'v1' = single-shot AES-GCM. */
    encryption_format: 'dce2' | 'v1' | null;
    has_password: boolean;
    has_thumbnail: boolean;
}

const toNum = (v: unknown): number => (v === null || v === undefined || v === '' ? 0 : Number(v));
const toNumOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function toPublicFile(f: Partial<FileRecord> & { share_id: string }): PublicFile {
    return {
        share_id: f.share_id,
        original_name: f.original_name ?? '',
        file_size: toNum(f.file_size),
        mime_type: f.mime_type || 'application/octet-stream',
        created_at: toNum(f.created_at),
        expires_at: toNumOrNull(f.expires_at),
        downloads: toNum(f.downloads),
        compression_ratio: f.compression_ratio ?? null,
        compression_speed: f.compression_speed ?? null,
        tags: f.tags ?? null,
        summary: f.summary ?? null,
        is_encrypted: Number(f.is_encrypted) === 1 ? 1 : 0,
        // The AES-GCM IV is not secret; clients need it to decrypt with the key from the URL fragment.
        encryption_iv: f.encryption_iv ?? null,
        encryption_format: Number(f.is_encrypted) !== 1 ? null : f.encryption_iv === DCE2_DB_MARKER ? 'dce2' : f.encryption_iv ? 'v1' : null,
        has_password: !!f.password_hash,
        has_thumbnail: !!f.thumbnail_path,
    };
}

export const FileRepository = {
    create: async (file: Omit<FileRecord, 'id' | 'created_at' | 'downloads' | 'last_accessed_at'>) => {
        const id = randomUUID();
        const now = Date.now();

        await db.query(`
            INSERT INTO files (
                id, user_id, share_id, original_name, sanitized_name, storage_path, thumbnail_path, password_hash,
                file_size, mime_type, created_at, expires_at, 
                compression_ratio, compression_speed,
                tags, summary, is_external, is_encrypted, encryption_iv, similarity_token
            ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20
            )
        `, [
            id, file.user_id || null, file.share_id, file.original_name, file.sanitized_name, file.storage_path, 
            file.thumbnail_path || null, file.password_hash || null,
            file.file_size, file.mime_type, now, file.expires_at || null,
            file.compression_ratio, file.compression_speed,
            file.tags ? JSON.stringify(file.tags) : null, file.summary || null, 
            file.is_external || 0, file.is_encrypted || 0,
            file.encryption_iv || null, file.similarity_token || null
        ]);

        return { ...file, id, created_at: now, downloads: 0, last_accessed_at: null };
    },

    /**
     * Records the Rust reactor's content class and recipe for a file. Best effort: a database whose
     * failure (e.g. a dev database that has not run `npm run db:migrate`) only logs a warning.
     */
    setReactorMeta: async (shareId: string, reactorClass: string | null, reactorRecipe: string | null) => {
        try {
            await db.query(
                'UPDATE files SET reactor_class = $1, reactor_recipe = $2 WHERE share_id = $3',
                [reactorClass, reactorRecipe, shareId]
            );
        } catch (e) {
            if (!reactorMetaWarned) {
                reactorMetaWarned = true;
                console.warn('[DB] Could not store reactor metadata (run `npm run db:migrate`):',
                    e instanceof Error ? e.message : e);
            }
        }
    },

    /** All file records, oldest first (maintenance scripts only). */
    listAll: async (): Promise<FileRecord[]> => {
        const res = await db.query('SELECT * FROM files ORDER BY created_at ASC');
        return res.rows;
    },

    /**
     * Compare-and-set relocation of a file's stored bytes (e.g. into the reactor store). Only updates when the record
     * still points at `expectedPath`; returns true when a row was changed.
     */
    relocateStorage: async (shareId: string, expectedPath: string, newPath: string, compressionRatio: string | null): Promise<boolean> => {
        const res = await db.query(
            'UPDATE files SET storage_path = $1, compression_ratio = $2, is_external = 0 WHERE share_id = $3 AND storage_path = $4',
            [newPath, compressionRatio, shareId, expectedPath]
        );
        return Number(res.rowCount) > 0;
    },

    findByShareId: async (shareId: string): Promise<FileRecord | undefined> => {
        const res = await db.query('SELECT * FROM files WHERE share_id = $1', [shareId]);
        return res.rows[0];
    },

    incrementDownloads: async (shareId: string) => {
        await db.query(`
            UPDATE files 
            SET downloads = downloads + 1, last_accessed_at = $1 
            WHERE share_id = $2
        `, [Date.now(), shareId]);
    },

    findExpired: async (now: number = Date.now()): Promise<FileRecord[]> => {
        const res = await db.query('SELECT * FROM files WHERE expires_at < $1', [now]);
        return res.rows;
    },

    delete: async (id: string) => {
        await db.query('DELETE FROM files WHERE id = $1', [id]);
    },

    findByUserId: async (userId: string): Promise<FileRecord[]> => {
        const res = await db.query('SELECT * FROM files WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
        return res.rows;
    },

    searchFiles: async (userId: string, query: string): Promise<FileRecord[]> => {
        const res = await db.query(`
            SELECT * FROM files 
            WHERE user_id = $1 
            AND (
                original_name ILIKE $2 
                OR CAST(tags AS TEXT) ILIKE $2 
                OR summary ILIKE $2
            ) 
            ORDER BY created_at DESC
        `, [userId, `%${query}%`]);
        return res.rows;
    }
};

export const ChunkRepository = {
    create: async (chunk: { id: string, original_size: number, hash: string }) => {
        await db.query('INSERT INTO chunks (id, original_size, hash) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING', [chunk.id, chunk.original_size, chunk.hash]);
    },
    findById: async (id: string) => {
        const res = await db.query('SELECT * FROM chunks WHERE id = $1', [id]);
        return res.rows[0];
    }
};

export const VariantRepository = {
    create: async (variant: Variant) => {
        await db.query(`
            INSERT INTO variants (id, chunk_id, algorithm, settings, quality, fitness, data)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            variant.id,
            variant.chunkId,
            variant.algorithm,
            variant.settings, // pg handles objects automatically if column is jsonb
            variant.quality,
            variant.fitness,
            variant.data
        ]);
    },
    findByChunkId: async (chunkId: string): Promise<Variant[]> => {
        const res = await db.query('SELECT * FROM variants WHERE chunk_id = $1', [chunkId]);
        return res.rows.map(r => ({
            id: r.id,
            chunkId: r.chunk_id,
            algorithm: r.algorithm,
            settings: r.settings,
            quality: r.quality,
            fitness: r.fitness,
            data: r.data
        }));
    }
};

export const SwarmNodeRepository = {
    pulse: async (nodeId: string, region: string, ip: string) => {
        await db.query(`
            INSERT INTO swarm_nodes (id, region, ip_address, last_pulse, status)
            VALUES ($1, $2, $3, $4, 'active')
            ON CONFLICT(id) DO UPDATE SET last_pulse = EXCLUDED.last_pulse, status = 'active'
        `, [nodeId, region, ip, Date.now()]);
    },
    getActive: async (withinMs: number = 60000) => {
        const now = Date.now();
        const res = await db.query('SELECT * FROM swarm_nodes WHERE last_pulse > $1 AND status = \'active\'', [now - withinMs]);
        return res.rows;
    },
    markOffline: async (nodeId: string) => {
        await db.query('UPDATE swarm_nodes SET status = \'offline\' WHERE id = $1', [nodeId]);
    }
};
