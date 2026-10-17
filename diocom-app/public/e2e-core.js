/*
 * DCE2 decrypt core for the e2e Service Worker (public/e2e-sw.js).
 *
 * Dependency-free mirror of the decrypt side of src/lib/crypto/dce2.ts (format documented there). Kept in sync by
 * tests/e2e_dce2.test.ts, which encrypts with the TypeScript module and decrypts with this file.
 * Loaded with importScripts() in the worker and require() in Node tests.
 */
(function (root) {
    'use strict';

    var HEADER_LENGTH = 44;
    var TAG_LENGTH = 16;
    var VERSION = 2;
    var ALG = 1;
    var MIN_CHUNK = 256;
    var MAX_CHUNK = 16 * 1024 * 1024;
    var MAX_CHUNKS = 4294967296;
    var HKDF_INFO = 'datran/dce2/v2/aes-256-gcm-chunk-key';
    var MAGIC = [0x44, 0x43, 0x45, 0x32];

    function FormatError(message) {
        var e = new Error(message);
        e.name = 'Dce2FormatError';
        return e;
    }
    function IntegrityError(message) {
        var e = new Error(message);
        e.name = 'Dce2IntegrityError';
        return e;
    }

    function chunkCount(h) {
        return Math.max(1, Math.ceil(h.plaintextLength / h.chunkSize));
    }
    function plainChunkLength(h, i) {
        var n = chunkCount(h);
        if (!(i >= 0 && i < n && Math.floor(i) === i)) throw FormatError('Chunk ' + i + ' out of range');
        return i < n - 1 ? h.chunkSize : h.plaintextLength - (n - 1) * h.chunkSize;
    }
    function cipherChunkOffset(h, i) {
        return HEADER_LENGTH + i * (h.chunkSize + TAG_LENGTH);
    }
    function ciphertextLength(h) {
        return HEADER_LENGTH + chunkCount(h) * TAG_LENGTH + h.plaintextLength;
    }

    function parseHeader(input) {
        if (!input || input.length < HEADER_LENGTH) throw FormatError('DCE2 header truncated');
        for (var m = 0; m < 4; m++) if (input[m] !== MAGIC[m]) throw FormatError('Not a DCE2 ciphertext (bad magic)');
        var bytes = new Uint8Array(input.subarray(0, HEADER_LENGTH));
        var view = new DataView(bytes.buffer);
        if (bytes[4] !== VERSION) throw FormatError('Unsupported DCE2 version ' + bytes[4]);
        if (bytes[5] !== ALG) throw FormatError('Unsupported DCE2 algorithm ' + bytes[5]);
        if (view.getUint16(6) !== 0 || bytes[43] !== 0) throw FormatError('DCE2 reserved header bytes must be zero');
        var chunkSize = view.getUint32(8);
        if (chunkSize < MIN_CHUNK || chunkSize > MAX_CHUNK) throw FormatError('Invalid DCE2 chunk size ' + chunkSize);
        var hi = view.getUint32(12);
        var lo = view.getUint32(16);
        if (hi >= 0x200000) throw FormatError('DCE2 plaintext length too large');
        var plaintextLength = hi * 4294967296 + lo;
        var h = {
            version: bytes[4],
            alg: bytes[5],
            chunkSize: chunkSize,
            plaintextLength: plaintextLength,
            salt: bytes.slice(20, 36),
            noncePrefix: bytes.slice(36, 43),
            bytes: bytes,
        };
        if (chunkCount(h) > MAX_CHUNKS) throw FormatError('DCE2 plaintext too long for the chunk size');
        return h;
    }

    /** Plaintext range [start, end) -> covering chunks and inclusive ciphertext byte range. */
    function plaintextRangeToCipherRange(h, start, end) {
        var L = h.plaintextLength;
        if (!(start >= 0 && end <= L && start <= end)) throw FormatError('Invalid plaintext range');
        if (start === end && L !== 0) throw FormatError('Empty plaintext range');
        var first = L === 0 ? 0 : Math.floor(start / h.chunkSize);
        var last = L === 0 ? 0 : Math.floor((end - 1) / h.chunkSize);
        return {
            firstChunk: first,
            lastChunk: last,
            cipherStart: cipherChunkOffset(h, first),
            cipherEnd: cipherChunkOffset(h, last) + plainChunkLength(h, last) + TAG_LENGTH - 1,
        };
    }

    function chunkNonce(h, i) {
        var nonce = new Uint8Array(12);
        nonce.set(h.noncePrefix, 0);
        new DataView(nonce.buffer).setUint32(7, i);
        nonce[11] = i === chunkCount(h) - 1 ? 1 : 0;
        return nonce;
    }

    function base64UrlDecode(s) {
        var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var bin = atob(b64);
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    function importMasterKey(key) {
        var raw = typeof key === 'string' ? base64UrlDecode(key) : key;
        if (raw.length < 16) return Promise.reject(FormatError('DCE2 link key too short'));
        return crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
    }

    function deriveFileKey(master, h) {
        return crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: h.salt, info: new TextEncoder().encode(HKDF_INFO) },
            master,
            { name: 'AES-GCM', length: 256 },
            false,
            ['decrypt']
        );
    }

    function decryptChunk(fileKey, h, i, ct) {
        var expected = plainChunkLength(h, i) + TAG_LENGTH;
        if (ct.length !== expected) {
            return Promise.reject(IntegrityError('Chunk ' + i + ' has ' + ct.length + ' bytes, expected ' + expected));
        }
        return crypto.subtle
            .decrypt({ name: 'AES-GCM', iv: chunkNonce(h, i), additionalData: h.bytes, tagLength: 128 }, fileKey, ct)
            .then(
                function (pt) { return new Uint8Array(pt); },
                function () { throw IntegrityError('Chunk ' + i + ' failed authentication (wrong key or tampered data)'); }
            );
    }

    function ExactReader(reader) {
        this.reader = reader;
        this.pending = [];
        this.pendingLen = 0;
        this.done = false;
    }
    ExactReader.prototype.read = async function (n) {
        while (this.pendingLen < n && !this.done) {
            var r = await this.reader.read();
            if (r.done) this.done = true;
            else if (r.value && r.value.length) {
                this.pending.push(r.value);
                this.pendingLen += r.value.length;
            }
        }
        var take = Math.min(n, this.pendingLen);
        var out = new Uint8Array(take);
        var off = 0;
        while (off < take) {
            var head = this.pending[0];
            var k = Math.min(head.length, take - off);
            out.set(head.subarray(0, k), off);
            off += k;
            if (k === head.length) this.pending.shift();
            else this.pending[0] = head.subarray(k);
        }
        this.pendingLen -= take;
        return out;
    };
    ExactReader.prototype.atEnd = async function () {
        if (this.pendingLen > 0) return false;
        if (this.done) return true;
        var extra = await this.read(1);
        if (extra.length) {
            this.pending.unshift(extra);
            this.pendingLen += extra.length;
            return false;
        }
        return true;
    };
    ExactReader.prototype.cancel = function (reason) {
        return this.reader.cancel(reason).catch(function () { });
    };

    /**
     * Plaintext stream for [start, end). openCiphertext(cipherStart, cipherEnd, signal) -> Promise<ReadableStream>.
     * Every chunk is authenticated before any of its bytes are emitted; failures error the stream.
     */
    function decryptRangeStream(o) {
        var h = o.header;
        var range = plaintextRangeToCipherRange(h, o.start, o.end);
        var ac = new AbortController();
        var reader = null;
        var index = range.firstChunk;
        return new ReadableStream({
            pull: async function (controller) {
                try {
                    if (!reader) reader = new ExactReader((await o.openCiphertext(range.cipherStart, range.cipherEnd, ac.signal)).getReader());
                    var need = plainChunkLength(h, index) + TAG_LENGTH;
                    var ct = await reader.read(need);
                    if (ct.length !== need) throw IntegrityError('Ciphertext ended inside chunk ' + index + ' (truncated)');
                    var pt = await decryptChunk(o.fileKey, h, index, ct);
                    var chunkStart = index * h.chunkSize;
                    var s = Math.max(o.start - chunkStart, 0);
                    var e = Math.min(o.end - chunkStart, pt.length);
                    if (e > s) controller.enqueue(pt.subarray(s, e));
                    index++;
                    if (index > range.lastChunk) {
                        var extra = !(await reader.atEnd());
                        await reader.cancel();
                        if (extra) throw IntegrityError('Unexpected bytes after the requested ciphertext range');
                        controller.close();
                    }
                } catch (err) {
                    ac.abort();
                    if (reader) await reader.cancel(err);
                    throw err;
                }
            },
            cancel: async function (reason) {
                ac.abort();
                if (reader) await reader.cancel(reason);
            },
        }, { highWaterMark: 1 });
    }

    var api = {
        HEADER_LENGTH: HEADER_LENGTH,
        TAG_LENGTH: TAG_LENGTH,
        parseHeader: parseHeader,
        chunkCount: chunkCount,
        plainChunkLength: plainChunkLength,
        cipherChunkOffset: cipherChunkOffset,
        ciphertextLength: ciphertextLength,
        plaintextRangeToCipherRange: plaintextRangeToCipherRange,
        importMasterKey: importMasterKey,
        deriveFileKey: deriveFileKey,
        decryptChunk: decryptChunk,
        decryptRangeStream: decryptRangeStream,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.DCE2 = api;
})(typeof self !== 'undefined' ? self : this);
