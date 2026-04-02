
import { ACSNode } from '../network/ACSNode';
import * as crypto from 'crypto';

async function runOracleSimulation() {
    console.log('--- THE ORACLE (Temporal Precognition) ---');
    console.log('Scenario: User accesses "Morning_Report.pdf" every day at 09:00.');

    const node = new ACSNode();

    // 1. Create the recurring data
    const data = Buffer.from("Important Morning Data");
    const chunkIds = node.ingestFile("report.pdf", data);
    const targetId = chunkIds[0];

    // 2. Train the Oracle (Simulate 5 days of history)
    console.log("\n[Training Phase] simulating 5 days of history...");

    // Set time to 09:00 for 5 consecutive days based on EPOCH
    const hourMs = 1000 * 60 * 60;
    const dayMs = hourMs * 24;

    // Base: A Random Monday at 09:00
    // Note: recordAccess uses Date.getHours()
    // We need to feed timestamps that correspond to 09:00 local time
    // Let's assume the machine local time.
    // Actually, TemporalPredictor extracts hours. We can just pick a base timestamp and add 24hrs.

    // Let's create a base date at 09:00 today.
    const baseDate = new Date();
    baseDate.setHours(9, 0, 0, 0);
    let time = baseDate.getTime();

    for (let d = 0; d < 5; d++) {
        await node.requestChunk(targetId, undefined, 'desktop', time);
        console.log(`Day ${d + 1}: Accessed at 09:00.`);
        time += dayMs; // Next day
    }

    // 3. The Test (Day 6, 08:00 AM)
    console.log("\n[Test Phase] It is now Day 6, 08:00 AM.");

    // Advance time to Day 6, 08:00
    time = baseDate.getTime() + (5 * dayMs) - hourMs; // 9am - 1hr = 8am

    console.log("Running Oracle Loop...");
    // This should trigger the prediction because history says "9am is hot"
    // And predictNeeds looks at (currentHour + 1)
    // Current Hour = 8. Next Hour = 9. 
    // History for 9 is 5. Threshold is 3. Prediction should fire.

    node.runOracleLoop(time);

    // 4. Time Passes... 09:00 AM arrives. User asks for file.
    console.log("[Time] Moving to 09:00 AM...");
    time += hourMs;

    const result = await node.requestChunk(targetId, undefined, 'desktop', time);

    console.log(`\n[Result] Request Time: ${result.timeMs.toFixed(2)}ms`);

    if (result.timeMs === 0) {
        console.log("SUCCESS: Negative Latency Achieved. The chunk was waiting.");
    } else {
        console.log("FAIL: The chunk was not pre-fetched.");
    }
}

runOracleSimulation();
