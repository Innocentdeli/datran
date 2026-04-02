export type FileType = 'video' | 'image' | 'audio' | 'pdf' | 'document' | 'archive' | 'code' | 'unknown';

export interface FileMetadata {
    id: string;
    name: string;
    type: FileType;
    extension: string;
    size?: number;
}

export function detectFileType(filename: string): FileType {
    const ext = filename.toLowerCase().split('.').pop() || '';

    // Video formats
    if (['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'm4v'].includes(ext)) {
        return 'video';
    }

    // Image formats
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
        return 'image';
    }

    // Audio formats
    if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'wma'].includes(ext)) {
        return 'audio';
    }

    // PDF format
    if (ext === 'pdf') {
        return 'pdf';
    }

    // Document formats
    if (['doc', 'docx', 'txt', 'md', 'rtf', 'odt'].includes(ext)) {
        return 'document';
    }

    // Archive formats
    if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'iso'].includes(ext)) {
        return 'archive';
    }

    // Code formats
    if (['js', 'ts', 'jsx', 'tsx', 'py', 'java', 'cpp', 'c', 'cs', 'go', 'rs', 'php', 'rb', 'swift', 'kt', 'html', 'css', 'json', 'xml', 'yaml', 'yml'].includes(ext)) {
        return 'code';
    }

    return 'unknown';
}

export function getFileIcon(type: FileType): string {
    const icons: Record<FileType, string> = {
        video: '🎬',
        image: '🖼️',
        audio: '🎵',
        pdf: '📄',
        document: '📄',
        archive: '📦',
        code: '💻',
        unknown: '📁',
    };

    return icons[type];
}

export function getMimeType(filename: string): string {
    const ext = filename.toLowerCase().split('.').pop() || '';

    const mimeTypes: Record<string, string> = {
        // Video
        mp4: 'video/mp4',
        webm: 'video/webm',
        ogg: 'video/ogg',

        // Image
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp',
        svg: 'image/svg+xml',

        // Audio
        mp3: 'audio/mpeg',
        wav: 'audio/wav',
        flac: 'audio/flac',

        // Document
        pdf: 'application/pdf',
        txt: 'text/plain',
        md: 'text/markdown',

        // Archive
        zip: 'application/zip',

        // Code
        js: 'text/javascript',
        ts: 'text/typescript',
        json: 'application/json',
        html: 'text/html',
        css: 'text/css',
    };

    return mimeTypes[ext] || 'application/octet-stream';
}
