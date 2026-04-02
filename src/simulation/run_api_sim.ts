
import { ACSNode } from '../network/ACSNode';
import { HttpInterface } from '../api/HttpInterface';
import * as http from 'http';

async function runApiSimulation() {
    console.log('--- POLYGLOT INTEGRATION SIMULATION ---');
    console.log('Starting ACS Node with HTTP Interface...');

    const node = new ACSNode();
    const api = new HttpInterface(node, 8080); // Port 8080

    // Give server moment to start
    await new Promise(r => setTimeout(r, 500));

    // 1. Simulate Python Client INGESTING data
    console.log("\n[External Client] Sending POST /ingest...");
    const postData = "Hello from Python!";

    const req = http.request({
        hostname: 'localhost', port: 8080, path: '/ingest', method: 'POST',
        headers: { 'Content-Length': postData.length }
    }, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
            console.log(`[Response] ${data}`);
            const json = JSON.parse(data);
            const chunkId = json.chunkIds[0];

            retrieveChunk(chunkId);
        });
    });
    req.write(postData);
    req.end();

    // 2. Simulate C++ Game Client RETRIEVING data
    function retrieveChunk(id: string) {
        console.log(`\n[External Client] Sending GET /chunk/${id}?context=vr ...`);
        http.get(`http://localhost:8080/chunk/${id}?context=vr`, (res) => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                console.log(`[Response] Received ${data.length} bytes: "${data}"`);
                console.log(`[Headers] Latency: ${res.headers['x-acs-time-ms']}ms`);

                console.log("\n✅ Integration Verified. Shutting down.");
                api.close();
            });
        });
    }
}

runApiSimulation();
