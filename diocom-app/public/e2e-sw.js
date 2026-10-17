/*
 * End-to-end decryption Service Worker (scope /v1/).
 *
 * Serves virtual URLs  /v1/e2e/<shareId>/<filename>[?dl=1]  by fetching only the needed ciphertext ranges from
 * /api/stream (same-origin, so unlock cookies apply), authenticating and decrypting DCE2 chunks, and streaming the
 * plaintext with correct 200/206/416, Content-Range, Content-Length and Content-Type. Media seeking, PDF/image
 * viewers and downloads therefore work with bounded memory.
 *
 * Keys come from the viewer page via postMessage (never from the network), live only in this worker's memory as
 * non-extractable CryptoKeys keyed by shareId, and expire after KEY_TTL_MS without use. If the worker was restarted
 * and lost them, it asks the open viewer windows again. Every other request in scope is left to the network.
 */
/* eslint-disable */
importScripts('/e2e-core.js');

var SW_VERSION = 1;
var PREFIX = '/v1/e2e/';
var KEY_TTL_MS = 30 * 60 * 1000;
var KEY_REQUEST_TIMEOUT_MS = 3000;
var ACTIVE_TYPES = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/ecmascript|text\/ecmascript)\b/i;

/** shareId -> { master: CryptoKey, name, mime, expires, info: Promise<{header, fileKey, total}> | null } */
var entries = new Map();

self.addEventListener('install', function () {
    self.skipWaiting();
});

self.addEventListener('activate', function (event) {
    event.waitUntil(self.clients.claim());
});

function sweep() {
    var now = Date.now();
    entries.forEach(function (e, id) {
        if (e.expires <= now) entries.delete(id);
    });
}
setInterval(sweep, 60 * 1000);

function touch(entry) {
    entry.expires = Date.now() + KEY_TTL_MS;
}

function reply(event, msg) {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(msg);
}

async function storeKey(shareId, key, name, mime) {
    var master = await DCE2.importMasterKey(key);
    var entry = { master: master, name: name || 'download', mime: mime || 'application/octet-stream', expires: 0, info: null };
    touch(entry);
    entries.set(shareId, entry);
    return entry;
}

self.addEventListener('message', function (event) {
    var data = event.data || {};
    if (event.origin && event.origin !== self.location.origin) return;
    if (data.type === 'e2e-register' && typeof data.shareId === 'string' && typeof data.key === 'string') {
        event.waitUntil(
            storeKey(data.shareId, data.key, data.name, data.mime).then(
                function () { reply(event, { ok: true }); },
                function (err) { reply(event, { ok: false, error: String((err && err.message) || err) }); }
            )
        );
    } else if (data.type === 'e2e-forget' && typeof data.shareId === 'string') {
        entries.delete(data.shareId);
        reply(event, { ok: true });
    } else if (data.type === 'e2e-claim') {
        event.waitUntil(self.clients.claim().then(function () { reply(event, { ok: true }); }));
    } else if (data.type === 'e2e-ping') {
        reply(event, { ok: true, version: SW_VERSION });
    }
});

/** Asks one window for the key of shareId; resolves null on timeout / no key. */
function askClient(client, shareId) {
    return new Promise(function (resolve) {
        var ch = new MessageChannel();
        var timer = setTimeout(function () { resolve(null); }, KEY_REQUEST_TIMEOUT_MS);
        ch.port1.onmessage = function (ev) {
            clearTimeout(timer);
            resolve(ev.data && typeof ev.data.key === 'string' ? ev.data : null);
        };
        client.postMessage({ type: 'e2e-key-request', shareId: shareId }, [ch.port2]);
    });
}

async function getEntry(shareId, event) {
    var entry = entries.get(shareId);
    if (entry && entry.expires > Date.now()) {
        touch(entry);
        return entry;
    }
    entries.delete(shareId);
    var candidates = [];
    if (event.clientId) {
        var c = await self.clients.get(event.clientId);
        if (c) candidates.push(c);
    }
    var all = await self.clients.matchAll({ type: 'window' });
    all.forEach(function (c) { if (candidates.indexOf(c) < 0) candidates.push(c); });
    if (!candidates.length) return null;
    var answers = await Promise.all(candidates.map(function (c) { return askClient(c, shareId); }));
    for (var i = 0; i < answers.length; i++) {
        if (answers[i]) return storeKey(shareId, answers[i].key, answers[i].name, answers[i].mime);
    }
    return null;
}

function HttpError(status, message) {
    var e = new Error(message);
    e.status = status;
    return e;
}

function streamUrl(shareId) {
    return '/api/stream?file=' + encodeURIComponent(shareId);
}

function totalFromContentRange(value) {
    var m = /\/(\d+)\s*$/.exec(value || '');
    return m ? parseInt(m[1], 10) : null;
}

async function readPrefix(body, n) {
    var reader = body.getReader();
    var out = new Uint8Array(n);
    var off = 0;
    while (off < n) {
        var r = await reader.read();
        if (r.done) break;
        var take = Math.min(r.value.length, n - off);
        out.set(r.value.subarray(0, take), off);
        off += take;
    }
    reader.cancel().catch(function () { });
    return out.subarray(0, off);
}

/** Header + derived key for an entry (cached on the entry). */
function getInfo(entry, shareId) {
    if (!entry.info) {
        entry.info = (async function () {
            var res = await fetch(streamUrl(shareId), {
                headers: { Range: 'bytes=0-' + (DCE2.HEADER_LENGTH - 1) },
                credentials: 'same-origin',
                cache: 'no-store',
            });
            if (res.status !== 200 && res.status !== 206) {
                if (res.body) res.body.cancel().catch(function () { });
                throw HttpError(res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410 ? res.status : 502, 'Ciphertext unavailable (HTTP ' + res.status + ')');
            }
            var total = res.status === 206
                ? totalFromContentRange(res.headers.get('content-range'))
                : (res.headers.get('content-length') ? parseInt(res.headers.get('content-length'), 10) : null);
            var header = DCE2.parseHeader(await readPrefix(res.body, DCE2.HEADER_LENGTH));
            if (total !== null && total !== DCE2.ciphertextLength(header)) {
                var e = new Error('Ciphertext is ' + total + ' bytes but the header implies ' + DCE2.ciphertextLength(header) + ' (truncated or extended)');
                e.name = 'Dce2IntegrityError';
                throw e;
            }
            var fileKey = await DCE2.deriveFileKey(entry.master, header);
            return { header: header, fileKey: fileKey, total: DCE2.ciphertextLength(header) };
        })();
        entry.info.catch(function () { entry.info = null; });
    }
    return entry.info;
}

/** Passes through `len` bytes of `body` after skipping `skip` bytes (server ignored our Range). */
function sliceStream(body, skip, len) {
    var reader = body.getReader();
    var skipped = 0;
    var sent = 0;
    return new ReadableStream({
        pull: async function (controller) {
            for (; ;) {
                if (sent >= len) {
                    reader.cancel().catch(function () { });
                    controller.close();
                    return;
                }
                var r = await reader.read();
                if (r.done) {
                    controller.close();
                    return;
                }
                var v = r.value;
                if (skipped < skip) {
                    var drop = Math.min(skip - skipped, v.length);
                    skipped += drop;
                    v = v.subarray(drop);
                }
                if (!v.length) continue;
                v = v.subarray(0, Math.min(v.length, len - sent));
                sent += v.length;
                controller.enqueue(v);
                return;
            }
        },
        cancel: function (reason) { return reader.cancel(reason); },
    });
}

function openCiphertextFor(shareId, total) {
    return async function (cs, ce, signal) {
        var res = await fetch(streamUrl(shareId), {
            headers: { Range: 'bytes=' + cs + '-' + ce },
            credentials: 'same-origin',
            cache: 'no-store',
            signal: signal,
        });
        if (res.status === 206) {
            var m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec((res.headers.get('content-range') || '').trim());
            if (!m || parseInt(m[1], 10) !== cs || parseInt(m[2], 10) !== ce || (m[3] !== '*' && parseInt(m[3], 10) !== total)) {
                res.body && res.body.cancel().catch(function () { });
                var e = new Error('Unexpected Content-Range ' + res.headers.get('content-range') + ' for bytes ' + cs + '-' + ce + '/' + total);
                e.name = 'Dce2IntegrityError';
                throw e;
            }
            return res.body;
        }
        if (res.status === 200 && res.body) return sliceStream(res.body, cs, ce - cs + 1);
        if (res.body) res.body.cancel().catch(function () { });
        throw HttpError(res.status, 'Ciphertext range unavailable (HTTP ' + res.status + ')');
    };
}

function parseRange(header, size) {
    if (!header) return { kind: 'none' };
    var m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m || (!m[1] && !m[2])) return { kind: 'none' };
    if (!m[1]) {
        var n = parseInt(m[2], 10);
        if (n === 0 || size === 0) return { kind: 'unsatisfiable' };
        return { kind: 'range', start: Math.max(0, size - n), end: size - 1 };
    }
    var start = parseInt(m[1], 10);
    var end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (m[2] && end < start) return { kind: 'none' };
    if (start >= size) return { kind: 'unsatisfiable' };
    return { kind: 'range', start: start, end: Math.min(end, size - 1) };
}

function contentDisposition(name) {
    var ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + encodeURIComponent(name);
}

function notifyError(shareId, err) {
    self.clients.matchAll({ type: 'window' }).then(function (cs) {
        cs.forEach(function (c) {
            c.postMessage({ type: 'e2e-error', shareId: shareId, name: (err && err.name) || 'Error', message: String((err && err.message) || err) });
        });
    });
}

/** Re-emits `inner`, reporting a failure to the viewer windows before erroring the response body. */
function reportingStream(inner, shareId) {
    var reader = inner.getReader();
    return new ReadableStream({
        pull: async function (controller) {
            try {
                var r = await reader.read();
                if (r.done) controller.close();
                else controller.enqueue(r.value);
            } catch (err) {
                notifyError(shareId, err);
                controller.error(err);
            }
        },
        cancel: function (reason) { return reader.cancel(reason); },
    }, { highWaterMark: 1 });
}

function textResponse(status, message) {
    return new Response(message, { status: status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function handle(event, url) {
    var parts = url.pathname.slice(PREFIX.length).split('/');
    var shareId;
    var pathName = '';
    try {
        shareId = decodeURIComponent(parts[0] || '');
        pathName = parts.length > 1 ? decodeURIComponent(parts.slice(1).join('/')) : '';
    } catch (e) {
        return textResponse(400, 'Bad request');
    }
    if (!shareId) return textResponse(400, 'Bad request');

    var entry = await getEntry(shareId, event);
    if (!entry) {
        var missing = new Error('Decryption key unavailable. Open the full share link (including #key=...) in this browser.');
        notifyError(shareId, missing);
        return textResponse(403, missing.message);
    }

    var info;
    try {
        info = await getInfo(entry, shareId);
    } catch (err) {
        notifyError(shareId, err);
        if (err && err.status) return textResponse(err.status, err.message);
        return textResponse(502, 'Decryption failed: ' + ((err && err.message) || err));
    }

    var h = info.header;
    var size = h.plaintextLength;
    var download = url.searchParams.get('dl') === '1';
    var name = pathName || entry.name;
    var type = entry.mime || 'application/octet-stream';
    var headers = {
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': type,
    };
    // Never let decrypted active content execute in our origin (SVG is allowed only as an <img> subresource).
    var imageSvg = /^image\/svg\+xml/i.test(type) && event.request.destination === 'image';
    if (ACTIVE_TYPES.test(type) && !imageSvg) {
        headers['Content-Type'] = 'application/octet-stream';
        download = true;
    }
    if (download) headers['Content-Disposition'] = contentDisposition(name);

    var r = parseRange(event.request.headers.get('range'), size);
    if (r.kind === 'unsatisfiable') {
        headers['Content-Range'] = 'bytes */' + size;
        headers['Content-Length'] = '0';
        return new Response(null, { status: 416, headers: headers });
    }
    var start = r.kind === 'range' ? r.start : 0;
    var endExcl = r.kind === 'range' ? r.end + 1 : size;
    var body = DCE2.decryptRangeStream({
        fileKey: info.fileKey,
        header: h,
        start: start,
        end: endExcl,
        openCiphertext: openCiphertextFor(shareId, info.total),
    });
    headers['Content-Length'] = String(endExcl - start);
    if (r.kind === 'range') {
        headers['Content-Range'] = 'bytes ' + start + '-' + (endExcl - 1) + '/' + size;
        return new Response(reportingStream(body, shareId), { status: 206, headers: headers });
    }
    return new Response(reportingStream(body, shareId), { status: 200, headers: headers });
}

self.addEventListener('fetch', function (event) {
    var req = event.request;
    if (req.method !== 'GET') return;
    var url = new URL(req.url);
    if (url.origin !== self.location.origin || url.pathname.indexOf(PREFIX) !== 0) return;
    event.respondWith(handle(event, url).catch(function (err) {
        return textResponse(500, 'Decryption worker error: ' + ((err && err.message) || err));
    }));
});
