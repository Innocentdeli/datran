
import * as fs from 'fs';
import * as path from 'path';

/**
 * THE OMNI DISPATCHER
 * 
 * 360-Degree Readiness:
 * The Dispatcher identifies the "Physical Intent" of data bits.
 */

export enum PhysicalModality {
    SEMANTIC = 'semantic', // Text, Code, JSON
    STRUCT = 'struct',     // UI, Static Screenshots, Line Art
    KIN = 'kin',           // Natural Video, Photos, Audio
    ATOM = 'atom',         // Compiled Binaries, Executables, ISOs
    VOID = 'void'          // Encrypted, Pre-compressed, Random
}

export class OmniDispatcher {

    /**
     * Identifies the modality of a file or buffer.
     */
    public static identify(data: Buffer, extension?: string): PhysicalModality {
        if (data.length === 0) return PhysicalModality.VOID;

        // 1. Check Extension (The "Surface" hint)
        const ext = (extension || '').toLowerCase();
        if (['.txt', '.ts', '.js', '.json', '.md', '.html', '.css', '.c', '.cpp', '.py'].includes(ext)) {
            return PhysicalModality.SEMANTIC;
        }
        if (['.iso', '.exe', '.dll', '.bin', '.dat', '.so'].includes(ext)) {
            return PhysicalModality.ATOM;
        }
        if (['.zip', '.rar', '.7z', '.gz', '.acs'].includes(ext)) {
            return PhysicalModality.VOID;
        }

        // 2. Intelligence: Atomic Signature Check (The "Magic Bytes")
        const header = data.subarray(0, 4).toString('hex');
        if (header === '7f454c46' || header === '4d5a9000') return PhysicalModality.ATOM; // ELF or PE
        if (header === '504b0304') return PhysicalModality.VOID; // ZIP

        // 3. Intelligence: Entropy Heatmap (The "Mathematical" Truth)
        const sample = data.subarray(0, Math.min(data.length, 10000));
        const unique = new Set(sample).size;

        // High density of unique bytes (near 256) = High Entropy
        // Low diversity (near 20-50) = Low Entropy
        if (unique < 100) return PhysicalModality.STRUCT; // Likely UI elements or sparse data
        if (unique > 240) return PhysicalModality.VOID;   // Likely Encrypted or Pre-compressed

        // Middle range is usually Natural Media or Human Code
        // We probe for ASCII presence
        let asciiCount = 0;
        for (let i = 0; i < sample.length; i++) {
            if (sample[i] >= 32 && sample[i] <= 126) asciiCount++;
        }

        if (asciiCount / sample.length > 0.8) return PhysicalModality.SEMANTIC;

        return PhysicalModality.KIN;
    }
}
