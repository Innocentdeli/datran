
import * as crypto from 'crypto';
import * as zlib from 'zlib';

/**
 * THE DIOCOM REACTOR V2.2 (GOD-TIER)
 * 
 * Adaptive Entropy-Based Compression:
 * Calculates Shannon entropy to dynamically route chunks to:
 * - Symbit Packing (Low Entropy < 3.0)
 * - Zlib Deflate (Mid Entropy 3.0 - 7.5)
 * - Raw Passthrough (High Entropy > 7.5)
 */
export class DiocomReactor {
    
    // Header flags
    private static FLAG_SYMBIT = 0x00;
    private static FLAG_ZLIB = 0x01;
    private static FLAG_RAW = 0x02;

    public static calculateEntropy(data: Buffer): number {
        if (data.length === 0) return 0;
        const counts = new Uint32Array(256);
        for (let i = 0; i < data.length; i++) counts[data[i]]++;
        
        let entropy = 0;
        for (let i = 0; i < 256; i++) {
            if (counts[i] === 0) continue;
            const p = counts[i] / data.length;
            entropy -= p * Math.log2(p);
        }
        return entropy;
    }

    public static compress(data: Buffer): Buffer {
        if (data.length === 0) return Buffer.from([this.FLAG_RAW]);

        const entropy = this.calculateEntropy(data);
        console.log(`[REACTOR] 🧠 Chunk Entropy Analyzed: ${entropy.toFixed(2)} bits/byte`);

        if (entropy >= 7.8) {
            // Highly random (encrypted or already compressed). Don't waste CPU.
            console.log(`[REACTOR] Routing: RAW Pass-through (High Entropy)`);
            const out = Buffer.alloc(data.length + 1);
            out[0] = this.FLAG_RAW;
            data.copy(out, 1);
            return out;
        } 
        
        if (entropy < 3.0) {
            console.log(`[REACTOR] Routing: SYMBIT Packing (Low Entropy)`);
            return this.compressSymbit(data);
        }

        console.log(`[REACTOR] Routing: ZLIB Deflation (Mid/High Entropy)`);
        const deflated = zlib.deflateRawSync(data);
        const out = Buffer.alloc(deflated.length + 1);
        out[0] = this.FLAG_ZLIB;
        deflated.copy(out, 1);
        return out;
    }

    private static compressSymbit(data: Buffer): Buffer {
        const counts = new Map<number, number>();
        for (let i = 0; i < data.length; i++) {
            const b = data[i];
            counts.set(b, (counts.get(b) || 0) + 1);
        }

        const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
        const map = new Map<number, number>();
        sorted.forEach(([byte, _], idx) => map.set(byte, idx));

        const uniqueCount = sorted.length;
        let bitWidth = 8;
        if (uniqueCount <= 2) bitWidth = 1;
        else if (uniqueCount <= 4) bitWidth = 2;
        else if (uniqueCount <= 16) bitWidth = 4;

        if (bitWidth === 8) {
            // Fallback to RAW if Symbit can't compress it
            const out = Buffer.alloc(data.length + 1);
            out[0] = this.FLAG_RAW;
            data.copy(out, 1);
            return out;
        }

        // Header: FLAG (1) + BitWidth (1) + TotalItems (4) + MapSize (1) + MapData (N)
        const mapSize = sorted.length;
        const headerSize = 1 + 1 + 4 + 1 + mapSize;
        const output = Buffer.alloc(data.length + headerSize);
        let offset = 0;

        output[offset++] = this.FLAG_SYMBIT;
        output.writeUInt8(bitWidth, offset++);
        output.writeUInt32BE(data.length, offset); offset += 4;
        output.writeUInt8(mapSize - 1, offset++);
        for (const [byte, _] of sorted) {
            output.writeUInt8(byte, offset++);
        }

        let currentByte = 0;
        let bitsUsed = 0;

        for (let i = 0; i < data.length; i++) {
            const sym = map.get(data[i])!;
            currentByte = (currentByte << bitWidth) | sym;
            bitsUsed += bitWidth;

            if (bitsUsed >= 8) {
                output.writeUInt8(currentByte & 0xFF, offset++);
                currentByte = 0;
                bitsUsed = 0;
            }
        }

        if (bitsUsed > 0) {
            output.writeUInt8((currentByte << (8 - bitsUsed)) & 0xFF, offset++);
        }

        return output.subarray(0, offset);
    }

    public static decompress(reactorData: Buffer): Buffer {
        if (reactorData.length === 0) return reactorData;

        let offset = 0;
        const flag = reactorData[offset++];

        if (flag === this.FLAG_RAW) {
            return reactorData.subarray(1);
        }

        if (flag === this.FLAG_ZLIB) {
            return zlib.inflateRawSync(reactorData.subarray(1));
        }

        if (flag === this.FLAG_SYMBIT) {
            const bitWidth = reactorData.readUInt8(offset++);
            const targetCount = reactorData.readUInt32BE(offset); offset += 4;
            const mapSize = reactorData.readUInt8(offset++) + 1;

            const reverseMap = Buffer.alloc(mapSize);
            for (let i = 0; i < mapSize; i++) {
                reverseMap[i] = reactorData.readUInt8(offset++);
            }

            const decoded = Buffer.alloc(targetCount);
            let itemsDecoded = 0;
            let currentByte = 0;
            let bitsAvailable = 0;
            const mask = (1 << bitWidth) - 1;

            while (itemsDecoded < targetCount) {
                if (bitsAvailable < bitWidth) {
                    currentByte = (currentByte << 8) | reactorData.readUInt8(offset++);
                    bitsAvailable += 8;
                }

                const sym = (currentByte >> (bitsAvailable - bitWidth)) & mask;
                decoded[itemsDecoded++] = reverseMap[sym];
                bitsAvailable -= bitWidth;
            }

            return decoded;
        }

        throw new Error("DiocomReactor: Unknown compression flag " + flag);
    }
}
