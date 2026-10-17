import * as fs from 'fs';
import { CompressionAlgorithm } from '../core/types';

/**
 * ACS container format shared by compress_real / decompress_real.
 *
 * v2 header (44 bytes): "ACS2" | original size (u64 BE) | SHA-256 of original (32 bytes)
 * then chunks: [1b algo id][4b BE payload size][payload]
 *
 * Legacy (v1) files have no header and start directly with chunks.
 */
export const ACS_MAGIC = Buffer.from('ACS2', 'latin1');
export const ACS_HEADER_SIZE = 4 + 8 + 32;

export const ACS_ALGO = {
    RAW: 0,
    LZ4: 1,          // lz4js frame
    BROTLI: 2,
    GENERATIVE: 3,   // reserved: lossy stub, never written, rejected on decode
    REACTOR: 4,      // DiocomReactor container (flag byte + payload)
} as const;

export const ACS_ALGO_IDS: Partial<Record<CompressionAlgorithm, number>> = {
    raw: ACS_ALGO.RAW,
    lz4: ACS_ALGO.LZ4,
    brotli: ACS_ALGO.BROTLI,
    reactor: ACS_ALGO.REACTOR,
};

export function writeAcsHeader(fd: number, originalSize: number, sha256: Buffer) {
    const header = Buffer.alloc(ACS_HEADER_SIZE);
    ACS_MAGIC.copy(header, 0);
    header.writeBigUInt64BE(BigInt(originalSize), 4);
    sha256.copy(header, 12);
    fs.writeSync(fd, header, 0, header.length, 0);
}

export function readAcsHeader(fd: number, fileSize: number): { originalSize: number; sha256: Buffer } | null {
    if (fileSize < ACS_HEADER_SIZE) return null;
    const header = Buffer.alloc(ACS_HEADER_SIZE);
    fs.readSync(fd, header, 0, ACS_HEADER_SIZE, 0);
    if (!header.subarray(0, 4).equals(ACS_MAGIC)) return null;
    return {
        originalSize: Number(header.readBigUInt64BE(4)),
        sha256: Buffer.from(header.subarray(12, 44)),
    };
}
