import { Directory, File, Paths } from 'expo-file-system';
import { Platform } from 'react-native';

export interface AutoSaveResult {
    success: boolean;
    localUri?: string;
    filename: string;
    size?: number;
    error?: string;
}

/**
 * Automatically downloads and writes a received P2P / Beamed / Paired file
 * directly into the device's persistent local Documents storage.
 *
 * This satisfies the requirement that P2P transfers are saved directly to device
 * storage rather than requiring the recipient to click and download through the web browser.
 */
export async function autoSaveFile(
    downloadUrl: string,
    suggestedFilename?: string,
): Promise<AutoSaveResult> {
    const rawName = suggestedFilename || downloadUrl.split('/').pop() || `beamed-${Date.now()}`;
    const safeFilename: string = (rawName.split('?')[0] ?? '').trim() || `beamed-${Date.now()}`;

    if (Platform.OS === 'web') {
        return { success: false, filename: safeFilename };
    }

    try {
        const destDir = new Directory(Paths.document);
        // Download directly into the app's documents directory
        const downloadedFile = await File.downloadFileAsync(downloadUrl, destDir, { idempotent: true });

        return {
            success: true,
            localUri: downloadedFile.uri,
            filename: downloadedFile.name || safeFilename,
            size: downloadedFile.size,
        };
    } catch (err) {
        console.warn('[Datran AutoSave] Failed to save file directly to local storage:', err);
        return {
            success: false,
            filename: safeFilename,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
