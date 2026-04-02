// Environment Configuration
// Environment Configuration

export const config = {
    // Server Configuration
    server: {
        url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        port: process.env.PORT || 3000,
    },

    // File Storage Configuration
    storage: {
        basePath: process.env.DIOCOM_STORAGE_PATH || 'C:/diocom',
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
        weissmanScore: parseFloat(process.env.WEISSMAN_SCORE || '59.04'),
        defaultRatio: parseFloat(process.env.DEFAULT_COMPRESSION_RATIO || '8.26'),
        defaultSpeed: process.env.DEFAULT_COMPRESSION_SPEED || '143.19 MB/s',
        largeFileThreshold: parseInt(process.env.LARGE_FILE_THRESHOLD_MB || '10'), // MB
    },

    // Network Configuration
    network: {
        meshNodes: parseInt(process.env.MESH_NODES || '411'),
        activeAtoms: process.env.ACTIVE_ATOMS === 'true' || true,
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
        debugLogPath: process.env.DEBUG_LOG_PATH || 'C:/diocom/STREAM_DEBUG.log',
    },
} as const;

// Helper to get base URL for share links
export function getShareLinkUrl(shareId: string): string {
    return `${config.server.url}/v1/${shareId}`;
}

// Helper to get storage path
export function getStoragePath(filename: string): string {
    return `${config.storage.basePath}/${filename}`;
}

// Helper to check if file size requires compression
export function shouldCompress(fileSizeMB: number): boolean {
    return fileSizeMB > config.compression.largeFileThreshold;
}
