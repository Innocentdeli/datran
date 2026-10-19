import { config } from '@/config';
import { validateFileType, validateMimeType, sanitizeFilename, ValidationError } from '@/lib/validation';
import { checkRateLimit, getClientIdentifier } from '@/lib/rateLimit';
import { hashPassword } from '@/lib/security';
import { FHELight } from '@/lib/FHELight';
import { DCE2_DB_MARKER, DCE2_FORMAT_FIELD } from '@/lib/crypto/dce2';

/**
 * Upload policy shared by every upload path (multipart POST /api/ingest and resumable tus /api/uploads): size limit,
 * anonymous-upload gate, creation rate limit, name/MIME checks and the parsing of the metadata fields.
 */

const DEFAULT_MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

/** Effective upload limit: MAX_UPLOAD_BYTES (default 200MB), never above config.storage.maxFileSize. */
export function getMaxUploadBytes(): number {
    const env = parseInt(process.env.MAX_UPLOAD_BYTES || '', 10);
    const limit = Number.isFinite(env) && env > 0 ? env : DEFAULT_MAX_UPLOAD_BYTES;
    return Math.min(limit, config.storage.maxFileSize);
}

/** ALLOW_ANONYMOUS_UPLOADS defaults to true for dev compatibility; set to 'false' to require login. */
export function anonymousUploadsAllowed(): boolean {
    return process.env.ALLOW_ANONYMOUS_UPLOADS !== 'false';
}

export type UploadRateLimit =
    | { allowed: true }
    | { allowed: false; retryAfter: number; resetAt: number; limit: number };

/**
 * One budget per client for starting uploads (an ingest POST or a tus creation POST); the chunk PATCHes of an
 * already created tus upload are not counted.
 */
export async function checkUploadRateLimit(request: Request): Promise<UploadRateLimit> {
    if (!config.rateLimit.enabled) return { allowed: true };
    const r = await checkRateLimit(`ingest:${getClientIdentifier(request)}`, {
        maxRequests: config.rateLimit.maxRequests,
        windowMs: config.rateLimit.windowMs,
    });
    if (r.allowed) return { allowed: true };
    return { allowed: false, retryAfter: r.retryAfter ?? 60, resetAt: r.resetAt, limit: config.rateLimit.maxRequests };
}

export function rateLimitHeaders(r: Extract<UploadRateLimit, { allowed: false }>): Record<string, string> {
    return {
        'X-RateLimit-Limit': r.limit.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': new Date(r.resetAt).toISOString(),
        'Retry-After': r.retryAfter.toString(),
    };
}

export function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    const trimmed = raw.trim();
    let tags: unknown = null;
    if (trimmed.startsWith('[')) {
        try {
            tags = JSON.parse(trimmed);
        } catch {
            throw new ValidationError('Invalid tags format', 'INVALID_TAGS');
        }
        if (!Array.isArray(tags)) throw new ValidationError('Invalid tags format', 'INVALID_TAGS');
    } else {
        tags = trimmed.split(',');
    }
    return (tags as unknown[])
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.trim().slice(0, 64))
        .filter(Boolean)
        .slice(0, 50);
}

/** Name/MIME checks that need only the declared name and type: run before any byte is stored. */
export function validateFileStart(filename: string, mimeType: string): void {
    const sanitizedName = sanitizeFilename(filename);
    if (config.validation.enableTypeCheck && config.storage.allowedExtensions[0] !== '*') {
        const typeValidation = validateFileType(sanitizedName, config.storage.allowedExtensions);
        if (!typeValidation.valid) throw new ValidationError(typeValidation.error || 'File type not allowed', typeValidation.code || 'INVALID_TYPE');
    }
    if (config.validation.enableMimeCheck) {
        const mimeValidation = validateMimeType(mimeType, config.validation.allowedMimeTypes);
        if (!mimeValidation.valid) throw new ValidationError(mimeValidation.error || 'MIME type not allowed', mimeValidation.code || 'INVALID_MIME');
    }
}

/** Upload options derived from the metadata fields (JSON-serializable: tus keeps them with the partial upload). */
export interface UploadMeta {
    /** scrypt hash of the share password (the plaintext is never stored). */
    passwordHash: string | null;
    tagsRaw: string | null;
    similarityToken: string | null;
    summary: string | null;
    isEncrypted: 0 | 1;
    /** DCE2 chunked E2E format (encryption_iv holds DCE2_DB_MARKER). */
    isDce2: boolean;
    encryptionIv: string | null;
}

/**
 * Parses and validates the metadata fields (multipart form fields or tus Upload-Metadata): password (hashed here),
 * tags, summary, is_encrypted / encryption_format / iv. Throws ValidationError.
 */
export async function parseUploadFields(fields: Readonly<Record<string, string | null | undefined>>): Promise<UploadMeta> {
    const str = (k: string) => (typeof fields[k] === 'string' ? fields[k] as string : null);
    const password = str('password');
    const tagsRaw = str('tags');
    const summary = str('summary')?.slice(0, 2000) ?? null;
    const isEncrypted: 0 | 1 = fields.is_encrypted === 'true' ? 1 : 0;
    const ivEntry = str('iv');
    // DCE2 (chunked streaming E2E format) carries its nonces in the ciphertext header; the record only stores the
    // format marker in encryption_iv (a v1 IV is 16 base64url chars, so the marker never collides).
    const isDce2 = isEncrypted === 1 && fields.encryption_format === DCE2_FORMAT_FIELD;
    const encryptionIv = isDce2
        ? DCE2_DB_MARKER
        : ivEntry !== null && /^[A-Za-z0-9_-]{1,64}$/.test(ivEntry) && ivEntry !== DCE2_DB_MARKER ? ivEntry : null;

    const tagsArray = parseTags(tagsRaw);
    // Deterministic HMAC tag over the sorted tag list (used for exact-match similarity).
    const similarityToken = FHELight.generateSimilarityToken(tagsArray);

    let passwordHash: string | null = null;
    if (password && password.trim().length > 0) {
        if (password.length > 1024) throw new ValidationError('Password too long', 'INVALID_PASSWORD');
        passwordHash = await hashPassword(password);
    }
    return { passwordHash, tagsRaw, similarityToken, summary, isEncrypted, isDce2, encryptionIv };
}
