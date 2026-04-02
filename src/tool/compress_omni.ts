
import * as fs from 'fs';
import * as path from 'path';
import { OmniDispatcher, PhysicalModality } from '../core/OmniDispatcher';
import { DiocomReactor } from '../core/DiocomReactor';
import * as zlib from 'zlib';
import { promisify } from 'util';

const brotli = promisify(zlib.brotliCompress);

async function omniForge(inputPath: string) {
    console.log(`\n🌪️ [DIOCOM OMNI V1.0] Commencing 360-Degree Singularity...`);

    if (!fs.existsSync(inputPath)) {
        console.error("Error: Input path not found.");
        return;
    }

    const stats = fs.statSync(inputPath);
    const totalSize = stats.size;
    const ext = path.extname(inputPath);
    const outputPath = inputPath + ".omni.acs";

    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const fd = fs.openSync(inputPath, 'r');
    const firstChunk = Buffer.alloc(1024 * 10);
    fs.readSync(fd, firstChunk, 0, 1024 * 10, 0);

    // --- OMNI DISPATCH ---
    const modality = OmniDispatcher.identify(firstChunk, ext);
    console.log(`Target:   ${path.basename(inputPath)} (${(totalSize / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`Modality: ${modality.toUpperCase()} detected.`);

    let totalRead = 0;
    let startTime = Date.now();
    const CHUNK_SIZE = 1 * 1024 * 1024;

    while (totalRead < totalSize) {
        const buffer = Buffer.alloc(CHUNK_SIZE);
        const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, totalRead);
        if (bytesRead <= 0) break;
        const slice = buffer.subarray(0, bytesRead);
        totalRead += bytesRead;

        let compressed: Buffer;
        let algoId = 0;

        // --- THE OMNI PRESSURE MATRIX ---
        switch (modality) {
            case PhysicalModality.SEMANTIC:
                // Global symbol mapping is best for text
                compressed = await brotli(slice, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
                algoId = 2;
                break;
            case PhysicalModality.STRUCT:
                // Proprietary Reactor for UI/Patterns
                compressed = DiocomReactor.compress(slice);
                algoId = 4;
                break;
            case PhysicalModality.KIN:
                // Adaptive Squeeze for Natural Media
                compressed = await brotli(slice, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } });
                algoId = 2;
                break;
            case PhysicalModality.ATOM:
                // Bit-level packing for Binaries
                compressed = DiocomReactor.compress(slice);
                algoId = 4;
                break;
            default:
                // Speed-Path for Encrypted/Random
                compressed = slice;
                algoId = 0;
        }

        // Final atomic wrap
        const h = Buffer.alloc(5);
        h.writeUInt8(algoId, 0);
        h.writeUInt32BE(compressed.length, 1);
        fs.appendFileSync(outputPath, h);
        fs.appendFileSync(outputPath, compressed);

        const progress = ((totalRead / totalSize) * 100).toFixed(1);
        const saved = ((1 - (fs.statSync(outputPath).size / totalRead)) * 100).toFixed(1);
        process.stdout.write(`\r[${progress}%] | Pressure: ACTIVE | Saved: ${saved}% | Speed: ${((totalRead / 1024 / 1024) / ((Date.now() - startTime) / 1000)).toFixed(1)} MB/s`);
    }

    fs.closeSync(fd);
    console.log(`\n\n✅ OMNI FORGE COMPLETE`);
    console.log(`Final Ratio: ${(totalSize / fs.statSync(outputPath).size).toFixed(2)}x`);
    console.log(`Singularity Link: diocom://share/${path.basename(outputPath)}`);
}

const target = process.argv[2] || "C:/diocom/DOCUMENTATION.md";
omniForge(target).catch(console.error);
