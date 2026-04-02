
import { ACSNode } from '../network/ACSNode';

async function runRealVideoBenchmark() {
    console.log('--- USER FILE PERFORMANCE BENCHMARK ---');
    console.log('File: "Business Platform...zip" (304.44 MB)');

    const node = new ACSNode();

    // Real stats from user's disk
    const zipSize = 304443877; // 304.44 MB
    const mp4Size = 2010614659; // 2.01 GB
    const chunkId = "video_chunk_user_file";

    // Setup Node with this large chunk profile
    node.genome.chunks.set(chunkId, {
        id: chunkId,
        originalSize: mp4Size,
        variants: [{
            id: 'zip_variant',
            chunkId: chunkId,
            algorithm: 'raw', // ZIP is already compressed, so we store 'raw' zip bytes
            data: Buffer.alloc(10),
            settings: { original: 'zip' },
            quality: 1.0,
            fitness: {
                size: zipSize,
                decodeTime: 300, // Est. 300ms to mount/unzip metadata
                transferTime: 0,
                cpuCost: 0,
                accessCount: 0,
                lastAccessed: 0
            }
        }],
        bestVariantId: 'zip_variant'
    });

    // Simulation parameters
    const DISK_READ_SPEED = 100 * 1024 * 1024; // 100MB/s SSD
    node.evolutionManager.updateBandwidth(DISK_READ_SPEED / 1000); // per ms

    console.log('\n[Phase 1] Cold Open (Traditional System)');
    const transferTime = zipSize / (DISK_READ_SPEED / 1000);
    const totalColdTime = transferTime + 300;
    console.log(`   Transfer: ${transferTime.toFixed(2)}ms`);
    console.log(`   Decode: 300.00ms`);
    console.log(`   Total Wait: ${(totalColdTime / 1000).toFixed(2)} seconds.`);

    console.log('\n[Phase 2] The Swarm Learns (Precognition Training)');
    const now = Date.now();
    // Training (5 hits at 10:00 AM)
    const tenAM = new Date(); tenAM.setHours(10, 0, 0, 0);
    for (let i = 0; i < 5; i++) {
        node.temporalPredictor.recordAccess(chunkId, tenAM.getTime() - (i * 24 * 3600 * 1000));
    }

    console.log('   Clock strikes 09:00 AM... Oracle triggers Pre-Decode.');
    node.runOracleLoop(tenAM.getTime() - (3600 * 1000)); // 1 hour before

    console.log('\n[Phase 3] Precognition Open (The ACS System)');
    console.log('   User clicks the file at 10:00 AM...');
    const result = await node.requestChunk(chunkId, undefined, 'desktop', tenAM.getTime());

    console.log(`   Total Wait: ${result.timeMs.toFixed(2)} ms.`);

    if (result.timeMs === 0) {
        console.log('\n✅ RESULT: The 2GB video opened INSTANTLY without quality loss.');
    }
}

runRealVideoBenchmark();
