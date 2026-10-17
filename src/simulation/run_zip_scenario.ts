
import { ACSNode } from '../network/ACSNode';
import { FitnessEvaluator } from '../evolution/FitnessEvaluator';
import * as crypto from 'crypto';

async function runZipScenario() {
    console.log('--- SCENARIO: "Business-management.zip" (High Entropy) ---');

    const node = new ACSNode();

    // 1. Generate 10MB of High-Entropy Data (Simulating a ZIP)
    // crypto.randomBytes is incompressible.
    const data = crypto.randomBytes(1024 * 1024 * 10);

    const chunkIds = await node.ingestFile("Business-management.zip", data);
    const chunkId = chunkIds[0];
    const chunk = node.genome.chunks.get(chunkId)!;

    // 2. Evolve
    console.log("Evolving variants...");
    await node.mutate(); // Tries to generate Brotli/Generative

    // 3. Evaluate Selection
    // We expect the system to REJECT Brotli/Generative because they add CPU cost with 0 Ratio gain.
    // It should select 'Raw'.
    await node.requestChunk(chunkId);
    node.optimize('desktop');

    const best = chunk.variants.find(v => v.id === chunk.bestVariantId)!;
    console.log(`\nBest Algorithm: ${best.algorithm.toUpperCase()}`);

    const ratio = chunk.originalSize / best.fitness.size;
    console.log(`Compression Ratio: ${ratio.toFixed(2)}x (Expected: ~1.0x due to entropy)`);

    if (best.algorithm !== 'raw') {
        console.log("WARNING: System tried to re-compress a ZIP file. Inefficient.");
    } else {
        console.log("SUCCESS: System detected High Entropy and avoided double-compression.");
    }

    // 4. Verify The Oracle (The Real Benefit for ZIPs)
    console.log("\nChecking Precognition...");
    const t0 = Date.now();
    node.temporalPredictor.recordAccess(chunkId, t0); // Train
    node.runOracleLoop(t0 + (24 * 3600 * 1000) - 3600); // Predict next day

    const req = await node.requestChunk(chunkId, undefined, 'desktop', t0 + (24 * 3600 * 1000));
    console.log(`Access Time: ${req.timeMs.toFixed(2)}ms`);

    if (req.timeMs === 0) {
        console.log("SUCCESS: Users opens ZIP instantly (0ms) due to Prediction.");
    }
}

runZipScenario();
