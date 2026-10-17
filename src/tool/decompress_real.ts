import * as crypto from 'crypto';
import * as fs from 'fs';
import * as zlib from 'zlib';
import * as lz4 from 'lz4js';
import { DiocomReactor } from '../core/DiocomReactor';
import { ACS_ALGO, ACS_HEADER_SIZE, readAcsHeader } from './acs_format';

function decodeChunk(algoId: number, data: Buffer): Buffer {
    switch (algoId) {
        case ACS_ALGO.RAW: return data;
        case ACS_ALGO.LZ4: return Buffer.from(lz4.decompress(data));
        case ACS_ALGO.BROTLI: return zlib.brotliDecompressSync(data);
        case ACS_ALGO.REACTOR: return DiocomReactor.decompress(data);
        case ACS_ALGO.GENERATIVE:
            throw new Error('Chunk uses the lossy "generative" stub; original bytes cannot be reconstructed');
        default:
            throw new Error(`Unknown chunk algorithm id ${algoId}`);
    }
}

/**
 * Usage: ts-node src/tool/decompress_real.ts <input.acs> [output]
 * Verifies size and SHA-256 when the container carries them (ACS v2). On mismatch the
 * output is deleted and an error is thrown.
 */
export async function decompressFile(inputPath: string, outputPath?: string) {
    console.log(`\n🧬 [ACS RESTORE V3.4] Reconstructing Genome (Local Mode)...`);

    if (!fs.existsSync(inputPath)) {
        throw new Error(`File not found at ${inputPath}`);
    }
    if (!outputPath) {
        outputPath = inputPath.endsWith('.acs') ? inputPath.slice(0, -4) + '.restored' : inputPath + '.restored';
    }

    DiocomReactor.verbose = false;
    const totalSize = fs.statSync(inputPath).size;
    const fd = fs.openSync(inputPath, 'r');
    const outFd = fs.openSync(outputPath, 'w');
    const hash = crypto.createHash('sha256');

    let ok = false;
    let written = 0;
    try {
        const meta = readAcsHeader(fd, totalSize);
        let offset = meta ? ACS_HEADER_SIZE : 0;
        if (!meta) {
            console.warn('[ACS] Legacy container without checksum: output cannot be verified.');
        }

        const startTime = Date.now();
        const header = Buffer.alloc(5);

        while (offset < totalSize) {
            if (offset + 5 > totalSize) throw new Error(`Truncated chunk header at offset ${offset}`);
            fs.readSync(fd, header, 0, 5, offset);
            offset += 5;

            const algoId = header.readUInt8(0);
            const chunkSize = header.readUInt32BE(1);
            if (offset + chunkSize > totalSize) throw new Error(`Truncated chunk at offset ${offset - 5}`);

            const compressedData = Buffer.alloc(chunkSize);
            fs.readSync(fd, compressedData, 0, chunkSize, offset);
            offset += chunkSize;

            const decompressed = decodeChunk(algoId, compressedData);
            hash.update(decompressed);
            written += fs.writeSync(outFd, decompressed, 0, decompressed.length, written);

            const progress = ((offset / totalSize) * 100).toFixed(1);
            const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.001);
            const speed = ((offset / 1024 / 1024) / elapsedSec).toFixed(2);
            process.stdout.write(`\r[${progress}%] | Reconstructing... | Speed: ${speed} MB/s`);
        }

        if (meta) {
            if (written !== meta.originalSize) {
                throw new Error(`Size mismatch: expected ${meta.originalSize} bytes, restored ${written}`);
            }
            const digest = hash.digest();
            if (!digest.equals(meta.sha256)) {
                throw new Error(`SHA-256 mismatch: expected ${meta.sha256.toString('hex')}, got ${digest.toString('hex')}`);
            }
            console.log(`\n[ACS] SHA-256 verified: ${digest.toString('hex')}`);
        }
        ok = true;
    } finally {
        fs.closeSync(fd);
        fs.closeSync(outFd);
        if (!ok && fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    }

    console.log(`\n✅ RECONSTRUCTION COMPLETE`);
    console.log(`Final File: ${(written / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Location:   ${outputPath}`);
    return outputPath;
}

if (require.main === module) {
    const [input, output] = process.argv.slice(2);
    if (!input) {
        console.error('Usage: ts-node src/tool/decompress_real.ts <input.acs> [output]');
        process.exit(2);
    }
    decompressFile(input, output).catch((e) => { console.error(`\n${e instanceof Error ? e.message : e}`); process.exit(1); });
}
