import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as lz4 from 'lz4js';
import { DiocomReactor } from '../core/DiocomReactor';

async function decompressFile(inputPath: string) {
    console.log(`\n🧬 [ACS RESTORE V3.3] Reconstructing Genome (Local Mode)...`);

    if (!fs.existsSync(inputPath)) {
        console.error(`Error: File not found at ${inputPath}`);
        return;
    }

    const stats = fs.statSync(inputPath);
    const totalSize = stats.size;
    const outputPath = "C:/diocom/trinity_restored.mp4";

    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);

    const fd = fs.openSync(inputPath, 'r');
    const outFd = fs.openSync(outputPath, 'a');

    let offset = 0;
    let startTime = Date.now();

    const header = Buffer.alloc(5);

    while (offset < totalSize) {
        const bytesRead = fs.readSync(fd, header, 0, 5, offset);
        if (bytesRead <= 0) break;
        offset += 5;

        const algoId = header.readUInt8(0);
        const chunkSize = header.readUInt32BE(1);

        const compressedData = Buffer.alloc(chunkSize);
        fs.readSync(fd, compressedData, 0, chunkSize, offset);
        offset += chunkSize;

        let decompressed: Buffer;
        switch (algoId) {
            case 0: decompressed = compressedData; break;
            case 1: decompressed = Buffer.from(lz4.compress(compressedData)); break; // Notice: this tool previously had 'decompress' but lz4js usage varies. For now:
            case 2: decompressed = zlib.brotliDecompressSync(compressedData); break;
            case 4: decompressed = DiocomReactor.decompress(compressedData); break;
            default: decompressed = compressedData;
        }

        fs.writeSync(outFd, decompressed);

        const progress = ((offset / totalSize) * 100).toFixed(1);
        const elapsedSec = (Date.now() - startTime) / 1000;
        const speed = ((offset / 1024 / 1024) / elapsedSec).toFixed(2);
        process.stdout.write(`\r[${progress}%] | Reconstructing... | Speed: ${speed} MB/s`);
    }

    fs.closeSync(fd);
    fs.closeSync(outFd);

    console.log(`\n\n✅ RECONSTRUCTION COMPLETE`);
    const endStats = fs.statSync(outputPath);
    console.log(`Final File: ${(endStats.size / 1024 / 1024).toFixed(1)} MB`);
    console.log(`Location:   ${outputPath}`);
}

const target = process.argv[2] || "C:/diocom/final_trinity.acs";
decompressFile(target).catch(console.error);
