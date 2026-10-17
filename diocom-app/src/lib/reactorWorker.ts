import { DiocomReactor, DictionaryUnavailableError } from '../../../src/core/DiocomReactor';

export { DictionaryUnavailableError };

/**
 * Reactor client (formerly a worker_threads entry point).
 *
 * Tries the native Rust reactor over HTTP first, then falls back to the in-process
 * TypeScript DiocomReactor. The previous worker path spawned a .ts file that plain Node
 * cannot load and never terminated the worker, so it has been removed.
 *
 * Env:
 *  - REACTOR_URL      (default http://127.0.0.1:${REACTOR_PORT || 3005})
 *  - REACTOR_TOKEN    optional; sent as `x-reactor-token`
 *  - REACTOR_TIMEOUT_MS (default 30000)
 */

export function getReactorUrl(): string {
    const fromEnv = process.env.REACTOR_URL;
    if (fromEnv) return fromEnv.replace(/\/+$/, '');
    return `http://127.0.0.1:${process.env.REACTOR_PORT || 3005}`;
}

export function reactorHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/octet-stream', ...extra };
    if (process.env.REACTOR_TOKEN) h['x-reactor-token'] = process.env.REACTOR_TOKEN;
    return h;
}

export function reactorTimeoutMs(): number {
    const n = parseInt(process.env.REACTOR_TIMEOUT_MS || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 30_000;
}

async function callReactor(op: 'compress' | 'decompress', data: Buffer, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const res = await fetch(`${getReactorUrl()}/${op}`, {
        method: 'POST',
        headers: reactorHeaders(extraHeaders),
        body: new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength),
        signal: AbortSignal.timeout(reactorTimeoutMs()),
    });
    if (!res.ok) throw new Error(`Reactor /${op} returned ${res.status}`);
    return res;
}

export interface CompressOptions {
    /** MIME type hint forwarded as `x-content-type` (used by the reactor to pick a content class). */
    contentType?: string;
    /**
     * Never let the reactor keep a sample of this upload for evolution (`x-reactor-no-sample: 1`).
     * Set for password-protected and client-side encrypted uploads.
     */
    noSample?: boolean;
}

export interface CompressResult {
    data: Buffer;
    engine: string;
    /** Engine-reported time in microseconds when available. */
    timeUs?: number;
    /** Content class chosen by the Rust reactor (x-reactor-class), if any. */
    reactorClass?: string | null;
    /** Compact recipe JSON used by the Rust reactor (x-reactor-recipe), if any. */
    reactorRecipe?: string | null;
}

// Header values come from a trusted local process, but they end up in the DB; keep them small and printable.
function cleanHeader(v: string | null, max: number, pattern: RegExp): string | null {
    if (!v || v.length > max || !pattern.test(v)) return null;
    return v;
}

function cleanRecipe(v: string | null): string | null {
    const s = cleanHeader(v, 512, /^[\x20-\x7e]+$/);
    if (!s) return null;
    try {
        const parsed = JSON.parse(s);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? JSON.stringify(parsed) : null;
    } catch {
        return null;
    }
}

export async function compressPayload(input: Buffer, options: CompressOptions = {}): Promise<CompressResult> {
    const extra: Record<string, string> = {};
    const mime = options.contentType?.trim();
    if (mime && mime.length <= 255 && /^[\x21-\x7e]+(\s*;[\x20-\x7e]*)?$/.test(mime)) extra['x-content-type'] = mime;
    if (options.noSample) extra['x-reactor-no-sample'] = '1';
    try {
        const res = await callReactor('compress', input, extra);
        const data = Buffer.from(await res.arrayBuffer());
        const timeUs = parseInt(res.headers.get('x-datran-time-us') || '', 10);
        return {
            data,
            engine: res.headers.get('x-datran-algo') || 'rust_core',
            timeUs: Number.isFinite(timeUs) ? timeUs : undefined,
            reactorClass: cleanHeader(res.headers.get('x-reactor-class'), 64, /^[A-Za-z0-9._+\-/]+$/),
            reactorRecipe: cleanRecipe(res.headers.get('x-reactor-recipe')),
        };
    } catch (e) {
        console.log(`[REACTOR] Rust reactor unavailable (${e instanceof Error ? e.message : e}); using TypeScript reactor.`);
        return { data: DiocomReactor.compress(input), engine: 'typescript' };
    }
}

/**
 * Decodes via Rust, falling back to the TypeScript reactor (legacy flags and blob v2).
 * Throws DictionaryUnavailableError when a v2 blob needs a zstd dictionary that is not available locally.
 */
export async function decompressPayload(input: Buffer): Promise<{ data: Buffer; engine: string }> {
    try {
        const res = await callReactor('decompress', input);
        return { data: Buffer.from(await res.arrayBuffer()), engine: 'rust_core' };
    } catch (e) {
        console.log(`[REACTOR] Rust reactor unavailable (${e instanceof Error ? e.message : e}); using TypeScript reactor.`);
        return { data: DiocomReactor.decompress(input), engine: 'typescript_fallback' };
    }
}
