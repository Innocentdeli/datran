
import { ACSNode } from '../network/ACSNode';
import * as crypto from 'crypto';

async function runSimulation() {
    console.log('--- INDUCTING ACS SIMULATION (v2 - Evolutionary) ---');

    const node = new ACSNode();

    // 1. Create Data
    const pattern = "The quick brown fox jumps over the lazy dog. ";
    let dataStr = "";
    for (let i = 0; i < 5000; i++) {
        dataStr += pattern + Math.random().toString(36).substring(7);
    }
    const data = Buffer.from(dataStr);

    // 2. Ingest
    const chunkIds = node.ingestFile("test.txt", data);
    console.log(`[Genesis] Ingested ${chunkIds.length} chunks (RAW state).`);

    // 3. Sim Loop
    const EPOCHS = 20;
    const REQUESTS_PER_EPOCH = 50;

    // Start with constrained bandwidth to favor compression
    node.evolutionManager.updateBandwidth(50); // 50 bytes/ms = 50KB/s (Slow)

    console.log(`\nEpoch | Avg Response (ms) | Dominant Algo | Variants/Chunk`);
    console.log(`---|---|---|---`);

    for (let e = 1; e <= EPOCHS; e++) {
        let totalTime = 0;

        // Introduce mutations (Network discovering new compression strats)
        if (e > 2) {
            node.mutate();
            node.mutate(); // Discover a few
        }

        for (let r = 0; r < REQUESTS_PER_EPOCH; r++) {
            const targetId = chunkIds[0]; // Hammer the first chunk to force evolution

            try {
                const res = await node.requestChunk(targetId);
                totalTime += res.timeMs;
            } catch (err) { }
        }

        const avgTime = totalTime / REQUESTS_PER_EPOCH;

        // Stats
        const chunks = Array.from(node.genome.chunks.values());
        const bests = chunks.map(c => c.variants.find(v => v.id === c.bestVariantId));

        // Most common algo
        const counts = bests.reduce((acc, v) => {
            acc[v!.algorithm] = (acc[v!.algorithm] || 0) + 1;
            return acc;
        }, {} as any);
        const dom = Object.entries(counts).sort((a: any, b: any) => b[1] - a[1])[0][0];

        const avgVars = chunks.reduce((acc, c) => acc + c.variants.length, 0) / chunks.length;

        console.log(`${e.toString().padEnd(5)} | ${avgTime.toFixed(4).padEnd(17)} | ${dom.padEnd(13)} | ${avgVars.toFixed(1)}`);

        node.optimize();
    }
}

runSimulation();
