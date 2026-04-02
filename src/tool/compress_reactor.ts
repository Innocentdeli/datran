
import * as fs from 'fs';
import * as path from 'path';
import { DiocomReactor } from '../core/DiocomReactor';

async function reactorForge(inputPath: string) {
    console.log(`\n🔥 [DIOCOM REACTOR FORGE] Igniting Proprietary Core...`);

    if (!fs.existsSync(inputPath)) return;

    const stats = fs.statSync(inputPath);
    const totalSize = stats.size;
    const outputPath = inputPath + ".reactor.acs";

    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const CHUNK_SIZE = 1 * 1024 * 1024; // 1MB blocks
    const fd = fs.openSync(inputPath, 'r');
    let totalRead = 0;
    let startTime = Date.now();

    console.log(`Target: ${path.basename(inputPath)} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`Algorithm: PROPRIETARY REACTOR V2.1 | Environment: PURE MATH`);

    while (totalRead < totalSize) {
        const buffer = Buffer.alloc(CHUNK_SIZE);
        const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, totalRead);
        if (bytesRead <= 0) break;
        const slice = buffer.subarray(0, bytesRead);
        totalRead += bytesRead;

        // --- THE PROPRIETARY CORE ---
        const compressed = DiocomReactor.compress(slice);

        // Header: [1b Algo=4, 4b Size]
        const h = Buffer.alloc(5);
        h.writeUInt8(4, 0);
        h.writeUInt32BE(compressed.length, 1);

        fs.appendFileSync(outputPath, h);
        fs.appendFileSync(outputPath, compressed);

        const progress = ((totalRead / totalSize) * 100).toFixed(1);
        const diskSize = fs.statSync(outputPath).size;
        const savings = ((1 - (diskSize / totalRead)) * 100).toFixed(1);
        process.stdout.write(`\r[${progress}%] | Reactor Heat: ACTIVE | Saved: ${savings}% | Speed: ${((totalRead / 1024 / 1024) / ((Date.now() - startTime) / 1000)).toFixed(1)} MB/s`);
    }

    fs.closeSync(fd);
    console.log(`\n\n✅ REACTOR FORGE COMPLETE`);
    const endStats = fs.statSync(outputPath);
    console.log(`Original: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Reactor:  ${(endStats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Efficiency: ${(totalSize / endStats.size).toFixed(2)}x Ratio`);
}

const target = process.argv[2] || "C:/diocom/41127-427876264.mp4";
reactorForge(target).catch(console.error);
