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

export function sanitizeFilename(filename: string): string {
    // Remove path traversal attempts
    let sanitized = filename.replace(/\.\./g, '');

    // Remove special characters that could cause issues (including spaces)
    sanitized = sanitized.replace(/[<>:"|?* ]/g, '_');

    // Remove leading/trailing spaces and dots
    sanitized = sanitized.trim().replace(/^\.+/, '');

    // Limit length
    if (sanitized.length > 255) {
        const ext = sanitized.split('.').pop() || '';
        const nameWithoutExt = sanitized.substring(0, sanitized.length - ext.length - 1);
        sanitized = nameWithoutExt.substring(0, 250 - ext.length) + '.' + ext;
    }

    return sanitized || 'unnamed_file';
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
