export class ValidationError extends Error {
    constructor(
        message: string,
        public code: string,
        public statusCode: number = 400
    ) {
        super(message);
        this.name = 'ValidationError';
    }
}

export class RateLimitError extends Error {
    constructor(
        message: string,
        public retryAfter: number
    ) {
        super(message);
        this.name = 'RateLimitError';
    }
}

export interface ValidationResult {
    valid: boolean;
    error?: string;
    code?: string;
}

export function validateFileSize(sizeBytes: number, maxSizeBytes: number): ValidationResult {
    if (sizeBytes === 0) {
        return {
            valid: false,
            error: 'File is empty',
            code: 'FILE_EMPTY'
        };
    }

    if (sizeBytes > maxSizeBytes) {
        const maxSizeMB = (maxSizeBytes / (1024 * 1024)).toFixed(0);
        const actualSizeMB = (sizeBytes / (1024 * 1024)).toFixed(2);
        return {
            valid: false,
            error: `File size (${actualSizeMB}MB) exceeds maximum allowed size (${maxSizeMB}MB)`,
            code: 'FILE_TOO_LARGE'
        };
    }

    return { valid: true };
}

export function validateFileType(
    filename: string,
    allowedExtensions: string[]
): ValidationResult {
    // If wildcard, allow all
    if (allowedExtensions.includes('*')) {
        return { valid: true };
    }

    const ext = filename.toLowerCase().split('.').pop() || '';

    if (!ext) {
        return {
            valid: false,
            error: 'File has no extension',
            code: 'NO_EXTENSION'
        };
    }

    if (!allowedExtensions.includes(ext)) {
        return {
            valid: false,
            error: `File type '.${ext}' is not allowed. Allowed types: ${allowedExtensions.join(', ')}`,
            code: 'INVALID_FILE_TYPE'
        };
    }

    return { valid: true };
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const MAX_FILENAME_LENGTH = 200;

/**
 * Produce a display-safe filename. NOTE: this is metadata only; on-disk names are
 * derived from random share ids, never from user input.
 */
export function sanitizeFilename(filename: string): string {
    let name = typeof filename === 'string' ? filename : '';

    // Basename only: drop any directory components (both separators)
    name = name.split(/[/\\]/).pop() || '';

    // Strip control characters (C0, DEL, C1) and Unicode bidi overrides
    name = name.replace(/[\u0000-\u001f\u007f-\u009f\u202A-\u202E\u2066-\u2069]/g, '');

    // Collapse any dot runs (removes '..')
    name = name.replace(/\.{2,}/g, '.');

    // Characters invalid on Windows / awkward in shells and URLs
    name = name.replace(/[<>:"|?*\s]/g, '_');

    // No leading dots (hidden files) and no trailing dots/underscores-from-spaces
    name = name.replace(/^[.]+/, '').replace(/[.]+$/, '');

    // Reserved Windows device names (CON, NUL, COM1, ... with or without extension)
    const stem = name.split('.')[0];
    if (WINDOWS_RESERVED.test(stem)) {
        name = `_${name}`;
    }

    // Length cap, preserving a short extension
    if (name.length > MAX_FILENAME_LENGTH) {
        const dot = name.lastIndexOf('.');
        const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
        name = name.slice(0, MAX_FILENAME_LENGTH - ext.length) + ext;
    }

    return name || 'unnamed_file';
}

export function validateMimeType(
    declaredMimeType: string,
    allowedMimeTypes: string[]
): ValidationResult {
    if (allowedMimeTypes.includes('*/*')) {
        return { valid: true };
    }

    const isAllowed = allowedMimeTypes.some(allowed => {
        if (allowed.endsWith('/*')) {
            const category = allowed.split('/')[0];
            return declaredMimeType.startsWith(category + '/');
        }
        return declaredMimeType === allowed;
    });

    if (!isAllowed) {
        return {
            valid: false,
            error: `MIME type '${declaredMimeType}' is not allowed`,
            code: 'INVALID_MIME_TYPE'
        };
    }

    return { valid: true };
}
