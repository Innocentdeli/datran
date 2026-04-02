
import { ACSNode } from '../network/ACSNode';
import { FitnessEvaluator } from '../evolution/FitnessEvaluator';
import * as crypto from 'crypto';

async function runWeissmanBenchmark() {
    console.log('--- WEISSMAN SCORE (Phase 5: Generative) ---');

    const node = new ACSNode();

    // 1. Ingest Data (Middle-Out Pattern)
    const pattern = Buffer.from("Middle-Out Compression Algorithm");
    const data = Buffer.alloc(1024 * 1024 * 10); // 10MB
    for (let i = 0; i < data.length; i += pattern.length) pattern.copy(data, i);

    const chunkIds = node.ingestFile("pied_piper.dat", data);
    const chunkId = chunkIds[0];
    const chunk = node.genome.chunks.get(chunkId)!;

    node.mutate();

    // 2. Inspect Variants
    // We want to see the Generative Variant specifically.
    const genVariant = chunk.variants.find(v => v.algorithm === 'generative');

    if (!genVariant) {
        console.log("Generative Variant not found! Evolution failed.");
        return;
    }

    // 3. Calculate Score manually for 'Space' Context
    const ratio = chunk.originalSize / genVariant.fitness.size;
    // Assume some transfer/decode time (Seed is tiny, but decode is fast-ish)
    genVariant.fitness.decodeTime = 5;
    genVariant.fitness.transferTime = 1; // Tiny transfer

    const wScore = FitnessEvaluator.calculateWeissmanScore(genVariant, chunk.originalSize, 'space');

    console.log(`Algo: ${genVariant.algorithm}`);
    console.log(`Original Size: ${chunk.originalSize} bytes`);
    console.log(`Compressed Size: ${genVariant.fitness.size} bytes`);
    console.log(`Ratio: ${ratio.toFixed(2)}x`);
    console.log(`Weissman Score: ${wScore.toFixed(2)}`);
}

runWeissmanBenchmark();
