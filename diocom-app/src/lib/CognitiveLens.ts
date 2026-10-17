/**
 * CognitiveLens
 *
 * Client-side rule-based tagger: derives tags/summary/category from the file's
 * MIME type and filename keywords. It does not read file contents and uses no AI model.
 * (Class name kept for existing callers.)
 */

export interface CognitiveMetadata {
    tags: string[];
    summary: string;
    category: string;
    sensitivity: string;
}

export class CognitiveLens {
    public static async analyze(file: File): Promise<CognitiveMetadata> {
        // Classification based on MIME type and filename only
        const lowerName = file.name.toLowerCase();
        
        let tags: string[] = [];
        let summary = '';
        let category = 'Unknown Binary';
        let sensitivity = 'Standard';

        if (file.type.startsWith('image/')) {
            tags = ['Visual', 'Media', file.type.split('/')[1]];
            summary = `Image file (${file.size} bytes).`;
            category = 'Image';
        } else if (file.type.startsWith('video/')) {
            tags = ['Video', 'Media', 'Streamable'];
            summary = `Video file (${file.size} bytes).`;
            category = 'Video';
        } else if (lowerName.includes('invoice') || lowerName.includes('receipt') || lowerName.includes('tax')) {
            tags = ['Financial', 'Confidential', 'Document'];
            summary = `Filename suggests a financial document.`;
            category = 'Document';
            sensitivity = 'High';
        } else if (lowerName.includes('code') || lowerName.endsWith('.ts') || lowerName.endsWith('.js') || lowerName.endsWith('.json')) {
            tags = ['Source Code', 'Development', 'Text'];
            summary = `Filename suggests source code or structured text.`;
            category = 'Code';
        } else {
            tags = ['Generic', 'Data'];
            summary = `Generic file (${file.size} bytes).`;
            category = 'Data';
        }

        return { tags, summary, category, sensitivity };
    }
}
