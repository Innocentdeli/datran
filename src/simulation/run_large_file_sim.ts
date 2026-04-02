
import { ACSNode } from '../network/ACSNode';

async function runLargeVideoSim() {
    console.log("--- LARGE VIDEO FILE SIMULATION (2.02GB -> 505MB ZIP) ---");
    const node = new ACSNode();

    // Mock a large file chunk (We don't actually alloc 500MB RAM to prevent crash in this small env)
    const chunkId = "business_management_zip";
    const fileSize = 505 * 1024 * 1024; // 505 MB

    node.genome.chunks.set(chunkId, {
        id: chunkId,
        originalSize: fileSize,
        variants: [{
            id: 'v1', chunkId: chunkId, algorithm: 'raw',
            data: Buffer.alloc(10), // Mock data holder
            settings: {},
            quality: 1.0,
            fitness: {
                size: fileSize,
                decodeTime: 500, // 500ms to unzip/decode
                transferTime: 0,
                cpuCost: 0,
                accessCount: 0,
                lastAccessed: 0
            }
        }],
        bestVariantId: 'v1'
    });

    // 1. Standard Request (Cold Start)
    // Simulate 100 MB/s SSD/Network speed
    // 100 MB/s = ~104,857 bytes/ms
    const BANDWIDTH = 104857;
    node.evolutionManager.updateBandwidth(BANDWIDTH);

    console.log("\n1. Standard Access (Cold Start)");
    console.log(`   Fetching 505MB at 100MB/s...`);

    // Manually calc "Cold" time because requestChunk has side effects we want to save for step 3
    const v = node.genome.chunks.get(chunkId)!.variants[0];
    const coldTime = (v.fitness.size / BANDWIDTH) + v.fitness.decodeTime;
    console.log(`   Open Time: ${(coldTime / 1000).toFixed(2)} seconds. (User Waits)`);

    // 2. Train Oracle (User opens this file every day)
    console.log("\n2. System Learns Pattern (The Oracle)...");
    const now = Date.now();
    // Simulate previous accesses
    node.temporalPredictor.recordAccess(chunkId, now);
    node.temporalPredictor.recordAccess(chunkId, now - (24 * 3600 * 1000));
    node.temporalPredictor.recordAccess(chunkId, now - (48 * 3600 * 1000));

    // 3. Pre-Decode (Precognition)
    // System predicts you will open it now, so it fetches it 5 mins ago.
    console.log("   Prediction triggered -> Pre-loading 505MB to RAM.");
    // Manually inject into cache to simulate 'runOracleLoop' success
    node['memoryCache'].set(chunkId, v.data);

    // 4. Optimized Request
    console.log("\n3. Precognition Access (User clicks file)");
    const t1 = await node.requestChunk(chunkId);
    console.log(`   Open Time: ${t1.timeMs.toFixed(2)} ms. (Instant)`);
}

runLargeVideoSim();
