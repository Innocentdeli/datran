
import { ACSNode } from '../network/ACSNode';
import * as crypto from 'crypto';

async function runForkedSimulation() {
    console.log('--- FORKED EVOLUTION SIMULATION (Mobile vs Desktop) ---');

    // Create two identical nodes initially
    const mobileNode = new ACSNode();
    const desktopNode = new ACSNode();

    // 1. Create Data
    const pattern = "The quick brown fox jumps over the lazy dog. ";
    let dataStr = "";
    for (let i = 0; i < 5000; i++) {
        dataStr += pattern + Math.random().toString(36).substring(7);
    }
    const data = Buffer.from(dataStr);

    // 2. Ingest into both
    const mobileIds = await mobileNode.ingestFile("data.txt", data);
    const desktopIds = await desktopNode.ingestFile("data.txt", data);

    // 3. Configure Environments
    // Mobile: Low Bandwidth (50 B/ms = 50KB/s), High CPU Penalty
    // Desktop: High Bandwidth (500000 B/ms = 500MB/s), Low CPU Penalty
    mobileNode.evolutionManager.updateBandwidth(50);
    desktopNode.evolutionManager.updateBandwidth(500000);

    const EPOCHS = 10;

    console.log(`\nEpoch | Mobile Algo | Mob Avg(ms) | Desktop Algo | Dsk Avg(ms)`);
    console.log(`---|---|---|---|---`);

    // Force discovery of variants early
    await mobileNode.mutate();
    await desktopNode.mutate();

    for (let e = 1; e <= EPOCHS; e++) {

        // Run Mobile Traffic
        let mobTotal = 0;
        for (let i = 0; i < 20; i++) {
            const res = await mobileNode.requestChunk(mobileIds[0], undefined, 'mobile');
            mobTotal += res.timeMs;
        }

        // Run Desktop Traffic
        let deskTotal = 0;
        for (let i = 0; i < 20; i++) {
            const res = await desktopNode.requestChunk(desktopIds[0], undefined, 'desktop');
            deskTotal += res.timeMs;
        }

        // Optimization Step - pass context!
        mobileNode.optimize('mobile');
        desktopNode.optimize('desktop');

        // Get stats
        const mobAlgo = getDominantAlgo(mobileNode);
        const deskAlgo = getDominantAlgo(desktopNode);

        console.log(`${e.toString().padEnd(5)} | ${mobAlgo.padEnd(11)} | ${(mobTotal / 20).toFixed(1).padEnd(11)} | ${deskAlgo.padEnd(12)} | ${(deskTotal / 20).toFixed(1)}`);
    }
}

function getDominantAlgo(node: ACSNode): string {
    const chunk = node.genome.chunks.values().next().value;
    const best = chunk.variants.find((v: any) => v.id === chunk.bestVariantId);
    return best ? best.algorithm : 'none';
}

runForkedSimulation();
