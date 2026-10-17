import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../../config';
import { StorageBackend, resolveStorageBackend, parseReactorStoragePath, REACTOR_PATH_PREFIX } from './reactorStoreCore';
import { deleteStoreFile } from './reactorStore';

/**
 * Storage keys must be generated server-side (random share ids), never taken from user input.
 * They are still validated here as defence in depth.
 */
const SAFE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/;

export interface StorageProvider {
    /** Stores the buffer under `key`. Returns a local absolute path or a URL. */
    upload(buffer: Buffer, key: string, contentType: string): Promise<string>;
    /** Deletes the object previously returned by upload(). Missing objects are ignored. */
    remove(location: string): Promise<void>;
    isExternal(): boolean;
}

/** Absolute storage root for local files. */
export function getStorageRoot(): string {
    return path.resolve(config.storage.basePath);
}

function assertSafeKey(key: string) {
    if (typeof key !== 'string' || !SAFE_KEY.test(key) || key.includes('..')) {
        throw new Error('Invalid storage key');
    }
}

/** True if `p` resolves to a location strictly inside `root`. */
export function isInsideRoot(p: string, root: string = getStorageRoot()): boolean {
    const resolved = path.resolve(p);
    const rel = path.relative(root, resolved);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Legacy uploads may live in the old `<cwd>/data/uploads` directory, so both roots are accepted
 * when serving or deleting existing records.
 */
const LEGACY_ROOT = path.resolve(process.cwd(), 'data', 'uploads');

/** Resolve a stored local path, returning null if it escapes the storage roots. */
export function resolveStoredPath(p: string | null | undefined): string | null {
    if (!p || typeof p !== 'string') return null;
    const resolved = path.resolve(p);
    if (isInsideRoot(resolved, getStorageRoot()) || isInsideRoot(resolved, LEGACY_ROOT)) return resolved;
    return null;
}

/** Path for a key inside the storage root (throws on unsafe keys). */
export function localPathForKey(key: string): string {
    assertSafeKey(key);
    const root = getStorageRoot();
    const full = path.resolve(root, key);
    if (!isInsideRoot(full, root)) throw new Error('Storage path escapes root');
    return full;
}

export const LocalStorage: StorageProvider = {
    upload: async (buffer, key) => {
        const filePath = localPathForKey(key);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        // 'wx' refuses to overwrite an existing object.
        await fs.promises.writeFile(filePath, buffer, { flag: 'wx' });
        return filePath;
    },
    remove: async (location) => {
        const p = resolveStoredPath(location);
        if (!p) return;
        await fs.promises.rm(p, { force: true });
    },
    isExternal: () => false
};

function s3Client() {
    return new S3Client({
        region: process.env.S3_REGION || 'us-east-1',
        credentials: {
            accessKeyId: process.env.S3_ACCESS_KEY || '',
            secretAccessKey: process.env.S3_SECRET_KEY || ''
        }
    });
}

const s3Bucket = () => process.env.S3_BUCKET || 'diocom-uploads';
const s3UrlPrefix = () => `https://${s3Bucket()}.s3.amazonaws.com/`;

export const S3Storage: StorageProvider = {
    upload: async (buffer, key, contentType) => {
        assertSafeKey(key);
        await s3Client().send(new PutObjectCommand({
            Bucket: s3Bucket(),
            Key: key,
            Body: buffer,
            ContentType: contentType,
        }));
        return `${s3UrlPrefix()}${key}`;
    },
    remove: async (location) => {
        if (!location || !location.startsWith(s3UrlPrefix())) return;
        const key = decodeURIComponent(location.slice(s3UrlPrefix().length));
        if (!key) return;
        await s3Client().send(new DeleteObjectCommand({ Bucket: s3Bucket(), Key: key }));
    },
    isExternal: () => true
};

/** Active backend for new uploads (STORAGE_BACKEND=reactor|local|s3; unset: s3 if CDN_ENABLED=true, else local). */
export function getStorageBackend(): StorageBackend {
    return resolveStorageBackend(process.env);
}

/**
 * Provider for objects the app stores itself: file bodies for the local/s3 backends, and thumbnails for every backend
 * (with STORAGE_BACKEND=reactor, thumbnails stay on S3 when CDN_ENABLED=true, else local disk).
 */
export function getStorageProvider(): StorageProvider {
    const backend = getStorageBackend();
    if (backend === 's3' || (backend === 'reactor' && process.env.CDN_ENABLED === 'true')) {
        return S3Storage;
    }
    return LocalStorage;
}

/**
 * Delete a stored object regardless of which backend wrote it. `reactor:<id>` paths unpin the file in the reactor
 * store (404 = already gone, tolerated); local paths and S3 URLs behave as before.
 */
export async function removeStoredObject(location: string | null | undefined, isExternal: boolean): Promise<void> {
    if (!location) return;
    const storeId = parseReactorStoragePath(location);
    if (storeId) {
        await deleteStoreFile(storeId);
        return;
    }
    if (location.startsWith(REACTOR_PATH_PREFIX)) return; // malformed reactor path: nothing we can address
    if (isExternal || /^https?:\/\//i.test(location)) {
        await S3Storage.remove(location);
    } else {
        await LocalStorage.remove(location);
    }
}
