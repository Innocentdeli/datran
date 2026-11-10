// Environment Configuration
// Environment Configuration

export const config = {
    // Server Configuration
    server: {
        url: process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || process.env.NEXTAUTH_URL || `http://localhost:${process.env.PORT || 3001}`,
        port: parseInt(process.env.PORT || '3001', 10),
    },

    // File Storage Configuration
    storage: {
        basePath: process.env.DIOCOM_STORAGE_PATH || './.storage',
        maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '1073741824'), // 1GB default
        allowedExtensions: process.env.ALLOWED_EXTENSIONS?.split(',') || ['*'], // All files by default
    },

    // Validation Configuration
    validation: {
        enableSizeCheck: process.env.ENABLE_SIZE_CHECK !== 'false',
        enableTypeCheck: process.env.ENABLE_TYPE_CHECK === 'true',
        enableMimeCheck: process.env.ENABLE_MIME_CHECK === 'true',
        allowedMimeTypes: process.env.ALLOWED_MIME_TYPES?.split(',') || ['*/*'],
    },

    // Rate Limiting Configuration
    rateLimit: {
        enabled: process.env.ENABLE_RATE_LIMIT !== 'false',
        maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '10'),
        windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000'), // 1 minute
    },

    // Compression Configuration
    compression: {
        largeFileThreshold: parseInt(process.env.LARGE_FILE_THRESHOLD_MB || '10'), // MB
    },

    // UI Configuration
    ui: {
        enableAnimations: process.env.ENABLE_ANIMATIONS !== 'false',
        logMaxVisible: parseInt(process.env.LOG_MAX_VISIBLE || '10'),
        analysisDelay: parseInt(process.env.ANALYSIS_DELAY_MS || '100'), // ms
    },

    // Debug Configuration
    debug: {
        enableDebugLogs: process.env.ENABLE_DEBUG_LOGS === 'true',
        debugLogPath: process.env.DEBUG_LOG_PATH || './.storage/STREAM_DEBUG.log',
    },
} as const;

/**
 * Resolves the absolute public origin dynamically.
 * Prioritizes:
 * 1. Explicitly configured APP_URL / NEXT_PUBLIC_APP_URL / NEXTAUTH_URL.
 * 2. Incoming request headers (x-forwarded-proto, x-forwarded-host, host) or request.url / nextUrl.
 * 3. Client-side window.location.origin (in browser).
 * 4. Fallback http://localhost:${PORT || 3001}.
 */
export function resolveOrigin(req?: Request | Headers | { headers?: Headers | Record<string, string | string[] | undefined>; url?: string; nextUrl?: { origin?: string } } | string | null): string {
    const configured = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL;
    if (configured) {
        try {
            return new URL(configured).origin;
        } catch { /* invalid: fall through */ }
    }

    if (typeof req === 'string' && req) {
        try {
            return new URL(req).origin;
        } catch { /* ignore */ }
    }

    if (req && typeof req === 'object') {
        let headers: Headers | null = null;
        if ('headers' in req && req.headers) {
            if (req.headers instanceof Headers) {
                headers = req.headers;
            } else if (typeof req.headers === 'object') {
                headers = new Headers();
                for (const [k, v] of Object.entries(req.headers)) {
                    if (typeof v === 'string') headers.set(k, v);
                    else if (Array.isArray(v) && v.length) headers.set(k, v.join(','));
                }
            }
        } else if (req instanceof Headers) {
            headers = req;
        }

        if (headers) {
            const host = headers.get('x-forwarded-host') || headers.get('host');
            if (host) {
                const proto = headers.get('x-forwarded-proto') ||
                    (headers.get('x-forwarded-ssl') === 'on' ? 'https' : 'http');
                return `${proto}://${host.split(',')[0].trim()}`;
            }
        }

        if ('nextUrl' in req && req.nextUrl?.origin) {
            return req.nextUrl.origin;
        }

        if ('url' in req && typeof req.url === 'string') {
            try {
                return new URL(req.url).origin;
            } catch { /* ignore */ }
        }
    }

    if (typeof window !== 'undefined' && window.location?.origin) {
        return window.location.origin;
    }

    return `http://localhost:${process.env.PORT || 3001}`;
}

/**
 * Public origin for absolute links: APP_URL / NEXTAUTH_URL when configured, else `requestOrigin`.
 */
export function publicOrigin(requestOrigin?: string): string | undefined {
    return resolveOrigin(requestOrigin);
}

// Helper to get base URL for share links
export function getShareLinkUrl(shareId: string, baseUrl?: string): string {
    return `${resolveOrigin(baseUrl)}/v1/${shareId}`;
}

// Helper to get storage path
export function getStoragePath(filename: string): string {
    return `${config.storage.basePath}/${filename}`;
}

// Helper to check if file size requires compression
export function shouldCompress(fileSizeMB: number): boolean {
    return fileSizeMB > config.compression.largeFileThreshold;
}
