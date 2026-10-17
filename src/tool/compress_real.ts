import { GenomeGenerator, REVERSIBLE_ALGORITHMS } from '../core/GenomeGenerator';
import { DiocomReactor } from '../core/DiocomReactor';
import { ACS_ALGO_IDS, ACS_MAGIC, ACS_HEADER_SIZE, writeAcsHeader } from './acs_format';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Usage: ts-node src/tool/compress_real.ts <input> [output.acs]
 *
 * Container (ACS v2): header (magic, original size, SHA-256 of original) followed by
 * chunks of [1b algo id][4b BE size][data]. Only lossless variants are ever written.
 */
export async function compressFile(inputPath: string, outputPath: string = inputPath + '.acs') {
    console.log(`\n🧬 [ACS FORGE V2.2] Initializing with Metadata Headers...`);

    if (!fs.existsSync(inputPath)) {
        throw new Error(`File not found at ${inputPath}`);
    }

    DiocomReactor.verbose = false;
    const totalSize = fs.statSync(inputPath).size;

    console.log(`Target: ${path.basename(inputPath)} (${(totalSize / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`Output: ${outputPath}`);

    const fd = fs.openSync(inputPath, 'r');
    const outFd = fs.openSync(outputPath, 'w');
    const CHUNK_SIZE = 1 * 1024 * 1024;
    const buffer = Buffer.alloc(CHUNK_SIZE);
    const hash = crypto.createHash('sha256');

    let totalProcessed = 0;
    let outOffset = ACS_HEADER_SIZE; // header is written last, once the hash is known
    const startTime = Date.now();

    console.log(`\nStarting Compression Loop...`);

    try {
        while (totalProcessed < totalSize) {
            const bytesRead = fs.readSync(fd, buffer, 0, CHUNK_SIZE, totalProcessed);
            if (bytesRead <= 0) break;

            const actualBuffer = buffer.subarray(0, bytesRead);
            hash.update(actualBuffer);
            const chunkId = `c_${totalProcessed}`;

            // 1. Generate lossless variants only
            const variants = GenomeGenerator.generateVariants(chunkId, actualBuffer)
                .filter(v => REVERSIBLE_ALGORITHMS.has(v.algorithm) && ACS_ALGO_IDS[v.algorithm] !== undefined);

            // 2. Pick smallest variant that provably decodes back to the input
            variants.sort((a, b) => a.fitness.size - b.fitness.size);
            let best = variants.find(v => v.algorithm === 'raw')!;
            for (const v of variants) {
                try {
                    if (GenomeGenerator.decodeVariant(v).equals(actualBuffer)) { best = v; break; }
                } catch { /* not decodable: skip */ }
            }

            // 3. Write [Header: 1b Algo, 4b Size][Data: content]
            const header = Buffer.alloc(5);
            header.writeUInt8(ACS_ALGO_IDS[best.algorithm]!, 0);
            header.writeUInt32BE(best.data.length, 1);
            outOffset += fs.writeSync(outFd, header, 0, header.length, outOffset);
            outOffset += fs.writeSync(outFd, best.data, 0, best.data.length, outOffset);

            totalProcessed += bytesRead;
            const progress = ((totalProcessed / totalSize) * 100).toFixed(1);
            const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.001);
            const speed = ((totalProcessed / 1024 / 1024) / elapsedSec).toFixed(2);

            process.stdout.write(`\r[${progress}%] | Current: ${best.algorithm.padEnd(8)} | Avg Speed: ${speed} MB/s | RAM: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(0)}MB`);
        }

        writeAcsHeader(outFd, totalProcessed, hash.digest());
    } finally {
        fs.closeSync(fd);
        fs.closeSync(outFd);
    }

    const endSize = fs.statSync(outputPath).size;
    console.log(`\n\n✅ COMPRESSION COMPLETE (${ACS_MAGIC.toString('latin1').trim()})`);
    console.log(`Original: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Final:    ${(endSize / 1024 / 1024).toFixed(1)} MB`);
    if (totalSize > 0) console.log(`Savings:  ${((1 - (endSize / totalSize)) * 100).toFixed(1)}%`);
    return outputPath;
}

if (require.main === module) {
    const [input, output] = process.argv.slice(2);
    if (!input) {
        console.error('Usage: ts-node src/tool/compress_real.ts <input> [output.acs]');
        process.exit(2);
    }
    compressFile(input, output).catch((e) => { console.error(e); process.exit(1); });
}
