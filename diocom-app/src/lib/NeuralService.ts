
import { startTransition } from 'react';

export interface NeuralAnalysis {
    tags: string[];
    summary: string;
    confidence: number;
    embedding?: number[]; // Placeholder for vector embedding
}

export class NeuralService {
    /**
     * Analyzes file content to generate tags and summary using heuristic analysis.
     * In Phase 32, this will be upgraded to use a local LLM or Vector DB.
     */
    static async analyze(file: File, contentSnippet?: string): Promise<NeuralAnalysis> {
        const tags = new Set<string>();
        const filename = file.name.toLowerCase();
        const type = file.type;

        // 1. Extension-based tagging
        const ext = filename.split('.').pop();
        if (ext) tags.add(ext);

        // 2. Type-based tagging
        if (type.startsWith('image')) tags.add('visual');
        if (type.startsWith('video')) tags.add('media');
        if (type.startsWith('audio')) tags.add('auditory');
        if (type.includes('pdf')) tags.add('document');
        if (type.includes('json') || type.includes('javascript') || type.includes('typescript')) {
            tags.add('code');
            tags.add('dev');
        }

        // 3. Keyword Extraction (Heuristic)
        if (contentSnippet) {
            const keywords = this.extractKeywords(contentSnippet);
            keywords.forEach(k => tags.add(k));
        }

        // 4. Generate Summary
        const summary = this.generateSummary(filename, tags, contentSnippet);

        // Simulate "Neural" processing time
        await new Promise(resolve => setTimeout(resolve, 500));

        return {
            tags: Array.from(tags),
            summary,
            confidence: 0.85
        };
    }

    private static extractKeywords(text: string): string[] {
        const stopWords = new Set(['the', 'is', 'at', 'which', 'on', 'and', 'a', 'an']);
        const words = text.toLowerCase().match(/\b(\w+)\b/g) || [];
        const freq = new Map<string, number>();

        words.forEach(w => {
            if (w.length > 4 && !stopWords.has(w)) {
                freq.set(w, (freq.get(w) || 0) + 1);
            }
        });

        // Return top 5 frequent words
        return Array.from(freq.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5)
            .map(([word]) => word);
    }

    private static generateSummary(filename: string, tags: Set<string>, snippet?: string): string {
        const type = tags.has('code') ? 'Source Code' :
            tags.has('document') ? 'Document' :
                tags.has('image') ? 'Image' : 'File';

        if (snippet && snippet.length > 50) {
            return `A ${type} related to ${Array.from(tags).slice(0, 3).join(', ')}. Preview: "${snippet.slice(0, 50)}..."`;
        }

        return `A ${type} named "${filename}" auto-tagged with: ${Array.from(tags).slice(0, 5).join(', ')}.`;
    }
}
