import busboy from 'busboy';
import { createHash } from 'crypto';
import { Readable } from 'stream';

/**
 * Streaming multipart/form-data parser for uploads (bounded memory regardless of file size).
 * No Next.js / '@/' imports: unit-tested from the repo root (tests/upload_stream.test.ts).
 *
 * Only the first file part named `file` is consumed (FormData.get('file') semantics); other file parts are drained.
 * While the file streams through, this computes the SHA-256 incrementally, keeps the first `headBytes` for
 * magic-byte sniffing and, for images, a copy capped at `imageBufferCap` for thumbnailing.
 *
 * Small files (<= `deferBytes`) are kept in memory and never reach a sink: the caller then knows every form field
 * (clients such as the web app send `is_encrypted`/`password` AFTER the file) before storing them. Larger files
 * open a sink (`openSink`) once the deferral buffer overflows and are streamed into it with backpressure.
 */

export interface UploadSink<T> {
    /** Resolves when the sink can accept more data (backpressure). Rejects if the sink failed. */
    write(chunk: Buffer): Promise<void>;
    /** Finishes the upload and resolves with the sink's result. */
    end(): Promise<T>;
    /** Aborts the upload; nothing may be committed. Must not throw. */
    abort(reason: Error): void;
}

export interface FileStartInfo {
    filename: string;
    mimeType: string;
}

export interface ParseOptions<T> {
    /** Max bytes for the `file` part; exceeding it aborts with UploadTooLargeError. */
    maxFileBytes: number;
    /** Files up to this many bytes stay in memory and never open a sink. */
    deferBytes: number;
    /** Images (declared image/*) up to this many bytes are also returned whole for thumbnailing. 0 disables. */
    imageBufferCap: number;
    /** Leading bytes kept for magic-byte sniffing. */
    headBytes?: number;
    /** Max bytes per text field (truncation is rejected). */
    maxFieldBytes?: number;
    maxFields?: number;
    /** Validate the file part before any byte is stored; throw to reject. */
    onFileStart?: (info: FileStartInfo, fieldsSoFar: Readonly<Record<string, string>>) => void;
    /** Opens the destination once the file outgrows `deferBytes`. `fieldsSoFar` are the fields sent before the file. */
    openSink: (info: FileStartInfo, fieldsSoFar: Readonly<Record<string, string>>) => UploadSink<T>;
}

export interface ParsedFile<T> {
    filename: string;
    mimeType: string;
    size: number;
    /** Lowercase hex SHA-256 of the file bytes. */
    sha256: string;
    head: Buffer;
    /** Whole file when it fit in `deferBytes` (no sink was opened), else null. */
    buffered: Buffer | null;
    /** Whole file for images <= imageBufferCap, else null. */
    imageBuffer: Buffer | null;
    /** Result of `sink.end()` when the file was streamed, else null. */
    sinkResult: T | null;
    /** Fields that arrived before the file part (what `openSink` saw). */
    fieldsBeforeFile: Readonly<Record<string, string>>;
}

export interface ParsedUpload<T> {
    fields: Record<string, string>;
    file: ParsedFile<T> | null;
}

export class UploadTooLargeError extends Error {
    constructor(readonly maxBytes: number) {
        super(`file exceeds ${maxBytes} bytes`);
        this.name = 'UploadTooLargeError';
    }
}

/** Malformed multipart body or field limits exceeded (maps to HTTP 400). */
export class MultipartError extends Error {
    constructor(message: string, readonly code: string = 'BAD_REQUEST') {
        super(message);
        this.name = 'MultipartError';
    }
}

const concat = (parts: Buffer[], total: number) => (parts.length === 1 ? parts[0] : Buffer.concat(parts, total));

export function parseMultipartUpload<T>(
    source: Readable,
    headers: Record<string, string>,
    opts: ParseOptions<T>,
): Promise<ParsedUpload<T>> {
    const headBytes = opts.headBytes ?? 4096;
    let bb: busboy.Busboy;
    try {
        bb = busboy({
            headers,
            limits: {
                fieldSize: opts.maxFieldBytes ?? 1024 * 1024,
                fields: opts.maxFields ?? 64,
                files: 8,
                parts: 128,
            },
        });
    } catch (e) {
        return Promise.reject(new MultipartError(`Invalid form data: ${e instanceof Error ? e.message : e}`));
    }

    return new Promise<ParsedUpload<T>>((resolve, reject) => {
        const fields: Record<string, string> = {};
        let fileTask: Promise<ParsedFile<T>> | null = null;
        let sink: UploadSink<T> | null = null;
        let failed: Error | null = null;
        let closed = false;

        const fail = (err: Error) => {
            if (failed) return;
            failed = err;
            if (sink) sink.abort(err);
            source.unpipe(bb);
            source.resume(); // drain the rest of the request so the client sees our response
            reject(err);
        };

        const finish = () => {
            if (failed || !closed) return;
            if (!fileTask) { resolve({ fields, file: null }); return; }
            fileTask.then(file => { if (!failed) resolve({ fields, file }); }, fail);
        };

        bb.on('field', (name, value, info) => {
            if (failed) return;
            if (info.nameTruncated || info.valueTruncated) { fail(new MultipartError(`Form field too large: ${name.slice(0, 64)}`, 'FIELD_TOO_LARGE')); return; }
            // First value wins (FormData.get semantics).
            if (!Object.prototype.hasOwnProperty.call(fields, name)) fields[name] = value;
        });

        bb.on('file', (name, stream, info) => {
            if (failed || fileTask || name !== 'file') { stream.resume(); return; }
            const meta: FileStartInfo = { filename: info.filename ?? '', mimeType: info.mimeType || '' };
            const fieldsBeforeFile = { ...fields };
            fileTask = (async (): Promise<ParsedFile<T>> => {
                try {
                    opts.onFileStart?.(meta, fieldsBeforeFile);
                } catch (e) {
                    stream.resume();
                    throw e;
                }
                const hash = createHash('sha256');
                const isImage = opts.imageBufferCap > 0 && meta.mimeType.toLowerCase().startsWith('image/');
                let size = 0;
                const headParts: Buffer[] = [];
                let headLen = 0;
                let pending: Buffer[] | null = [];
                let pendingLen = 0;
                let image: Buffer[] | null = isImage ? [] : null;
                for await (const raw of stream) {
                    if (failed) break;
                    const chunk = raw as Buffer;
                    size += chunk.length;
                    if (size > opts.maxFileBytes) { stream.resume(); throw new UploadTooLargeError(opts.maxFileBytes); }
                    hash.update(chunk);
                    if (headLen < headBytes) {
                        const take = chunk.subarray(0, headBytes - headLen);
                        headParts.push(Buffer.from(take)); // copy: never pin a large chunk for the head
                        headLen += take.length;
                    }
                    if (image) {
                        if (size <= opts.imageBufferCap) image.push(chunk);
                        else image = null; // over the cap: no thumbnail, release the copy
                    }
                    if (pending) {
                        pending.push(chunk);
                        pendingLen += chunk.length;
                        if (pendingLen > opts.deferBytes) {
                            sink = opts.openSink(meta, fieldsBeforeFile);
                            const queued = pending;
                            pending = null;
                            pendingLen = 0;
                            for (const p of queued) await sink.write(p);
                        }
                    } else if (sink) {
                        await sink.write(chunk);
                    }
                }
                if (failed) throw failed;
                const sinkResult = sink ? await sink.end() : null;
                return {
                    filename: meta.filename,
                    mimeType: meta.mimeType,
                    size,
                    sha256: hash.digest('hex'),
                    head: concat(headParts, headLen),
                    buffered: pending ? concat(pending, pendingLen) : null,
                    imageBuffer: image ? concat(image, Math.min(size, opts.imageBufferCap)) : null,
                    sinkResult,
                    fieldsBeforeFile,
                };
            })();
            fileTask.catch(fail);
        });

        bb.on('fieldsLimit', () => fail(new MultipartError('Too many form fields', 'TOO_MANY_FIELDS')));
        bb.on('partsLimit', () => fail(new MultipartError('Too many form parts', 'TOO_MANY_FIELDS')));
        bb.on('error', (e: unknown) => fail(new MultipartError(`Invalid form data: ${e instanceof Error ? e.message : e}`)));
        bb.on('close', () => { closed = true; finish(); });
        source.on('error', (e: Error) => fail(e));
        source.on('aborted', () => fail(new Error('client aborted the upload')));
        source.pipe(bb);
    });
}

/** Magic-byte sniff of the leading bytes. Informational / used to gate thumbnailing; never trusts the declared type. */
export function sniffFileType(head: Uint8Array): string | null {
    const b = head;
    const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
    const ascii = (i: number, s: string) => b.length >= i + s.length && [...s].every((c, k) => b[i + k] === c.charCodeAt(0));
    if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
    if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
    if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
    if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp';
    if (ascii(4, 'ftyp')) {
        if (ascii(8, 'avif') || ascii(8, 'avis')) return 'image/avif';
        if (ascii(8, 'heic') || ascii(8, 'heix') || ascii(8, 'mif1')) return 'image/heic';
        return 'video/mp4';
    }
    if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';
    if (ascii(0, 'BM') && b.length >= 14) return 'image/bmp';
    if (ascii(0, '%PDF-')) return 'application/pdf';
    if (at(0, 0x50, 0x4b, 0x03, 0x04)) return 'application/zip';
    if (at(0, 0x1f, 0x8b)) return 'application/gzip';
    if (at(0, 0x28, 0xb5, 0x2f, 0xfd)) return 'application/zstd';
    if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return 'video/webm';
    if (ascii(0, 'OggS')) return 'audio/ogg';
    if (ascii(0, 'ID3') || at(0, 0xff, 0xfb)) return 'audio/mpeg';
    return null;
}

/** Raster formats sharp can thumbnail. */
export function isThumbnailableImage(sniffed: string | null): boolean {
    return sniffed !== null && ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/tiff', 'image/heic'].includes(sniffed);
}

/**
 * Whether the reactor may sample a streamed upload. Fields sent after the file are unknown when the stream starts,
 * so sampling is allowed only when the client declared BOTH flags up front as "not encrypted, no password".
 */
export function mayStreamSample(fieldsBeforeFile: Readonly<Record<string, string>>): boolean {
    const has = (k: string) => Object.prototype.hasOwnProperty.call(fieldsBeforeFile, k);
    return has('is_encrypted') && fieldsBeforeFile.is_encrypted !== 'true'
        && has('password') && fieldsBeforeFile.password.trim().length === 0;
}
