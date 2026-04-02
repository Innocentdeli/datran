
import { ACSNode } from '../network/ACSNode';
import { Variant } from '../core/types';
import * as crypto from 'crypto';

async function runQualitySimulation() {
    console.log('--- QUALITY EVOLUTION SIMULATION (Cinema vs Mobile) ---');

    const node = new ACSNode();

    // Create 1MB of RANDOM data (High Entropy -> Low Compression)
    const data = crypto.randomBytes(1024 * 1024);
    const chunkIds = node.ingestFile("video.mp4", data);
    const chunkId = chunkIds[0];

    node.mutate();
    node.mutate();

    const chunk = node.genome.chunks.get(chunkId)!;
    // console.log(`Variants Generated: ${chunk.variants.map(v => v.algorithm).join(', ')}`);

    console.log(`\nEpoch | Context | Best Algo | Quality Score | Size (MB)`);
    console.log(`---|---|---|---|---`);

    // 1. Mobile Test
    // Bandwidth constrained. Should prefer LZ4/Brotli/Raw over 2MB Upscale
    node.evolutionManager.updateBandwidth(100);

    for (let i = 0; i < 10; i++) {
        await node.requestChunk(chunkId, undefined, 'mobile');
    }
    node.optimize('mobile');
    let best = chunk.variants.find(v => v.id === chunk.bestVariantId)!;
    console.log(`1     | Mobile  | ${best.algorithm.padEnd(10)} | ${best.quality.toFixed(2)}          | ${(best.data.length / 1024 / 1024).toFixed(2)}`);

    // 2. Cinema Test
    // Bandwidth infinite. Quality critical.
    node.evolutionManager.updateBandwidth(500000); // 500MB/ms

    chunk.bestVariantId = chunk.variants[0].id;

    for (let i = 0; i < 10; i++) {
        await node.requestChunk(chunkId, undefined, 'cinema'); // High Quality Importance
    }
    node.optimize('cinema');
    best = chunk.variants.find(v => v.id === chunk.bestVariantId)!;
    console.log(`2     | Cinema  | ${best.algorithm.padEnd(10)} | ${best.quality.toFixed(2)}          | ${(best.data.length / 1024 / 1024).toFixed(2)}`);
}

runQualitySimulation();
