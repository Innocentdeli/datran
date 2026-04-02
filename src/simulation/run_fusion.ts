
import { ACSNode } from '../network/ACSNode';

async function runFusionSimulation() {
    console.log('--- SELF-REWRITING (FUSION) SIMULATION ---');

    const node = new ACSNode();

    // 1. Ingest Data (Creates Chunks A,B,C,D...)
    // Make checks > 100 bytes (CHUNK_SIZE in ACSNode)
    let str = "";
    for (let i = 0; i < 50; i++) str += "Chunk_Data_Block_" + i + " ";
    const data = Buffer.from(str);

    const chunkIds = node.ingestFile("data.dat", data);
    console.log(`[Genesis] Created ${chunkIds.length} chunks.`);

    if (chunkIds.length < 2) {
        console.log("Error: Not enough chunks to simulate fusion.");
        return;
    }

    // 2. Simulate Correlation (A -> B always)
    console.log(`[Traffic] Simulating correlated access ${chunkIds[0].substr(0, 4)} -> ${chunkIds[1].substr(0, 4)}...`);

    for (let i = 0; i < 20; i++) {
        // Request A
        await node.requestChunk(chunkIds[0]);
        // Request B (Previous = A)
        await node.requestChunk(chunkIds[1], chunkIds[0]);
    }
}

runFusionSimulation();
