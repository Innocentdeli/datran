
import { ACSNode } from '../network/ACSNode';

async function runSwarmSimulation() {
    console.log('--- SWARM GRAVITY SIMULATION ---');

    // 1. Setup Nodes
    const usNode = new ACSNode('us-east');
    const euNode = new ACSNode('eu-west');

    // 2. Ingest Data into US Node
    const data = Buffer.from("Global Data Set " + Math.random());
    const chunkIds = usNode.ingestFile("global.dat", data);
    console.log(`[Genesis] Data born in ${usNode.region}.`);

    // 3. Simulate Traffic from EU
    console.log(`[Traffic] Generating 100 requests from eu-west...`);

    for (let i = 0; i < 100; i++) {
        // We are simulating that 'euNode' is forwarding requests to 'usNode'
        // or users in EU are hitting US node directly.
        // The node 'usNode' sees the request coming from 'eu-west'.
        try {
            await usNode.requestChunk(chunkIds[0], undefined, 'desktop'); // client context
            // Manually trigger the region record since we don't have full RPC
            usNode.replicationManager.recordRequest(chunkIds[0], 'eu-west');
        } catch (e) { }
    }

    // 4. Check if Migration Triggered
    // The logs should show [Gravity] Moving Chunk...

    // 5. Simulate Mixed Traffic (Replication but no migration)
    console.log(`\n[Traffic] Generating mixed traffic (US + EU)...`);
    for (let i = 0; i < 50; i++) {
        usNode.replicationManager.recordRequest(chunkIds[0], 'eu-west');
        usNode.replicationManager.recordRequest(chunkIds[0], 'us-east');
    }
}

runSwarmSimulation();
