
import * as http from 'http';
import * as url from 'url';
import { ACSNode } from '../network/ACSNode';
import { ClientContext } from '../core/types';

/**
 * Universal Interface Layer.
 * Allows Python, C++, Rust, Go, etc. to talk to the Organism.
 */
export class HttpInterface {
    private node: ACSNode;
    private server: http.Server;

    constructor(node: ACSNode, port: number = 3000) {
        this.node = node;
        this.server = http.createServer((req, res) => this.handle(req, res));
        this.server.listen(port, () => {
            console.log(`[ACS Organism] Alive on port ${port}. Ready for polyglot interaction.`);
        });
    }

    private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
        const parsed = url.parse(req.url!, true);

        // 1. INGEST (POST /ingest)
        // Used by: Python Scrapers, C++ Game Engines, etc.
        if (req.method === 'POST' && parsed.pathname === '/ingest') {
            let body: Buffer[] = [];
            req.on('data', (chunk) => body.push(chunk));
            req.on('end', async () => {
                try {
                    const data = Buffer.concat(body);
                    const ids = await this.node.ingestFile('upload_' + Date.now(), data);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'Inducted', chunkIds: ids }));
                } catch (e) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ status: 'Error', error: (e as Error).message }));
                }
            });
            return;
        }

        // 2. RETRIEVE (GET /chunk/:id)
        // Used by: Video Players, Web Browsers, VR Headsets
        // Params: ?context=mobile|vr|space
        if (req.method === 'GET' && parsed.pathname?.startsWith('/chunk/')) {
            const id = parsed.pathname.split('/')[2];
            const context = (parsed.query.context as ClientContext) || 'server';

            try {
                const start = process.hrtime();
                const result = await this.node.requestChunk(id, undefined, context);
                const end = process.hrtime(start);
                const duration = (end[0] * 1000 + end[1] / 1e6).toFixed(2);

                res.writeHead(200, {
                    'Content-Type': 'application/octet-stream',
                    'X-ACS-Time-Ms': duration,
                    'X-ACS-Algo': 'optimized' // In real app we'd need to expose this from RequestResult
                });
                res.write(result.data);
                res.end();
            } catch (e) {
                res.writeHead(404);
                res.end("Organism could not locate chunk.");
            }
            return;
        }

        res.writeHead(404);
        res.end("ACS Interface. Endpoints: POST /ingest, GET /chunk/:id");
    }

    public close() {
        this.server.close();
    }
}
