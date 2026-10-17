
import { ACSNode } from '../network/ACSNode';
import * as crypto from 'crypto';

async function runStreamSimulation() {
    console.log('--- REAL-TIME VIDEO STREAM SIMULATION (30 FPS) ---');
    console.log('Scenario: Bandwidth drops mid-call. System must adapt instantly.');

    const node = new ACSNode();

    // 1. Setup: Start with Good Network (WiFi)
    console.log(`\n[Time 0s] Network: HIGH BANDWIDTH (1000 bytes/ms)`);
    node.evolutionManager.updateBandwidth(1000);

    let lastAlgo = 'none';

    // Simulate 30 Frames
    for (let frame = 1; frame <= 30; frame++) {

        // Generate Frame Data (Random noise to simulate video entropy)
        // 100KB frame
        const frameData = crypto.randomBytes(1024 * 100);
        const chunkIds = await node.ingestFile(`frame_${frame}.dat`, frameData);
        const chunkId = chunkIds[0];

        // Force mutation so we have options
        await node.mutate();

        // Frame 15: NETWORK CRASH (Switch to Cellular)
        if (frame === 15) {
            console.log(`\n[Time 0.5s] ⚠️ NETWORK DROPPED TO 50 bytes/ms ⚠️`);
            node.evolutionManager.updateBandwidth(50);
        }

        // Frame 25: NETWORK RECOVERY
        if (frame === 25) {
            console.log(`\n[Time 0.8s] ✅ NETWORK RESTORED`);
            node.evolutionManager.updateBandwidth(1000);
        }

        // Request the frame (Video Chat Context)
        await node.requestChunk(chunkId, undefined, 'mobile');
        node.optimize('mobile');

        const chunk = node.genome.chunks.get(chunkId)!;
        const best = chunk.variants.find(v => v.id === chunk.bestVariantId)!;

        // Log only changes or key frames
        if (best.algorithm !== lastAlgo || frame === 15 || frame === 25) {
            console.log(`Frame ${frame} | Bandwidth: ${node.evolutionManager['bandwidthEstimate']} | Algo: ${best.algorithm.padEnd(8)} | Time: ${best.fitness.decodeTime.toFixed(2)}ms`);
        }
        lastAlgo = best.algorithm;
    }
}

runStreamSimulation();
