import { parentPort, workerData } from 'worker_threads';
import { DiocomReactor } from '../../../src/core/DiocomReactor';

/**
 * Reactor Worker Thread
 * 
 * Offloads heavy bit-packing logic from the main API thread.
 */

if (!parentPort) {
    process.exit(1);
}

const { data } = workerData;

try {
    const buffer = Buffer.from(data);
    const compressed = DiocomReactor.compress(buffer);
    parentPort.postMessage({ success: true, compressed });
} catch (error: any) {
    parentPort.postMessage({ success: false, error: error.message });
}
