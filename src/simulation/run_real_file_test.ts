
import { ACSNode } from '../network/ACSNode';
import * as fs from 'fs';
import * as path from 'path';

async function runRealFileTest() {
    console.log('--- REAL FILE TEST: 5MB SERVER LOG ---');

    const node = new ACSNode();

    // 1. Generate "Real" File (5MB of JSON Logs)
    console.log("Generating 5MB Log File...");
    const logEntries = [];
    for (let i = 0; i < 10000; i++) {
        logEntries.push({
            timestamp: Date.now() + i,
            level: i % 10 === 0 ? 'ERROR' : 'INFO',
            message: `User ${Math.floor(Math.random() * 1000)} performed action ${Math.random().toString(36).substring(7)}`,
            metadata: {
                region: 'us-east-1',
                latency: Math.random() * 100
            }
        });
    }
    const fileContent = Buffer.from(JSON.stringify(logEntries, null, 2)); // Pretty print to make it compressible but large
    const fileName = "server_logs.json";

    console.log(`File Size: ${(fileContent.length / 1024 / 1024).toFixed(2)} MB`);

    // 2. Ingest
    console.log("Ingesting...");
    const startIngest = Date.now();
    const chunkIds = await node.ingestFile(fileName, fileContent);
    console.log(`Ingested in ${Date.now() - startIngest}ms. Split into ${chunkIds.length} chunks.`);

    // 3. Mutate (Evolution)
    console.log("Evolving variants...");
    await node.mutate();
    await node.mutate(); // Do it twice to ensure we get some good compression variants

    // 4. Test Contexts
    const chunkId = chunkIds[0]; // Test the first chunk
    const chunk = node.genome.chunks.get(chunkId)!;

    console.log(`\nAnalyzing Chunk 0 (${chunk.originalSize} bytes)...`);

    // A. Space Connection (Bandwidth Constraint)
    console.log("\nContext: SPACE (Expensive Bandwidth)");
    await node.requestChunk(chunkId, undefined, 'space');
    node.optimize('space');
    let best = chunk.variants.find(v => v.id === chunk.bestVariantId)!;
    console.log(` Selected: ${best.algorithm}`);
    console.log(` Size: ${best.fitness.size} bytes (Ratio: ${(chunk.originalSize / best.fitness.size).toFixed(1)}x)`);

    // B. VR Connection (Latency Constraint)
    console.log("\nContext: VR (Expensive Latency)");
    // Clear cache to simulate network pull
    node['memoryCache'].clear();
    await node.requestChunk(chunkId, undefined, 'vr');
    node.optimize('vr');
    best = chunk.variants.find(v => v.id === chunk.bestVariantId)!;
    console.log(` Selected: ${best.algorithm}`);
    console.log(` Decode Time: ${best.fitness.decodeTime}ms`);
}

runRealFileTest();
