
import { ACSNode } from '../network/ACSNode';
import { GenomeGenerator } from '../core/GenomeGenerator';
import * as fs from 'fs';
import * as path from 'path';

async function compressFile(inputPath: string) {
    console.log(`\n🧬 [ACS FORGE V2.1] Initializing with Metadata Headers...`);

    if (!fs.existsSync(inputPath)) {
        console.error(`Error: File not found at ${inputPath}`);
        return;
    }

    const stats = fs.statSync(inputPath);
    const totalSize = stats.size;
    const node = new ACSNode('server', { initialChunkSize: 1024 * 1024 });
    const outputPath = inputPath + ".acs";

    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    console.log(`Target: ${path.basename(inputPath)} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`Output: ${path.basename(outputPath)}`);

    const fd = fs.openSync(inputPath, 'r');
    const CHUNK_SIZE = 1 * 1024 * 1024;
    const buffer = Buffer.alloc(CHUNK_SIZE);

    let totalProcessed = 0;
    let startTime = Date.now();

    console.log(`\nStarting Compression Loop...`);

    const algos: Record<string, number> = { 'raw': 0, 'lz4': 1, 'brotli': 2, 'generative': 3 };

    while (totalProcessed < totalSize) {
        const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, totalProcessed);
        if (bytesRead <= 0) break;

        const actualBuffer = buffer.subarray(0, bytesRead);
        const chunkId = `c_${totalProcessed}`;

        // 1. Generate variants
        const variants = GenomeGenerator.generateVariants(chunkId, actualBuffer);

        // 2. Pick best for size
        let best = variants[0];
        for (const v of variants) {
            if (v.fitness.size < best.fitness.size) best = v;
        }

        // 3. Write [Header: 1b Algo, 4b Size][Data: content]
        const algoId = algos[best.algorithm] ?? 0;
        const header = Buffer.alloc(5);
        header.writeUInt8(algoId, 0);
        header.writeUInt32BE(best.data.length, 1);

        fs.appendFileSync(outputPath, header);
        fs.appendFileSync(outputPath, best.data);

        totalProcessed += bytesRead;
        const progress = ((totalProcessed / totalSize) * 100).toFixed(1);
        const elapsedSec = (Date.now() - startTime) / 1000;
        const speed = ((totalProcessed / 1024 / 1024) / elapsedSec).toFixed(2);

        process.stdout.write(`\r[${progress}%] | Current: ${best.algorithm.padEnd(8)} | Avg Speed: ${speed} MB/s | RAM: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)}MB`);
    }

    fs.closeSync(fd);

    const endStats = fs.statSync(outputPath);
    console.log(`\n\n✅ COMPRESSION COMPLETE`);
    console.log(`Original: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Final:    ${(endStats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Savings:  ${((1 - (endStats.size / totalSize)) * 100).toFixed(1)}%`);
}

const target = process.argv[2] || "C:/diocom/Business Platform - Google Chrome 2025-12-01 09-24-22.mp4";
compressFile(target).catch(console.error);
