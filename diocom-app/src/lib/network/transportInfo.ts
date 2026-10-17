/**
 * Measured transport information. Everything here is read from what the browser actually
 * negotiated; nothing is inferred from API availability.
 *
 *  - HTTP protocol: PerformanceNavigationTiming / PerformanceResourceTiming `nextHopProtocol`
 *    (ALPN id: 'h3' = HTTP/3 over QUIC, 'h2', 'http/1.1'). The browser reports '' when it cannot
 *    say (e.g. served from cache, or a cross-origin resource without Timing-Allow-Origin).
 *    Note: a browser usually learns about HTTP/3 from the Alt-Svc header of a first HTTP/2
 *    response, so the very first page load is commonly 'h2' and later ones 'h3'.
 *  - WebRTC: the selected ICE candidate pair from RTCPeerConnection.getStats().
 */

export type ProtocolSnapshot = string | null; // null = not measurable (SSR / no entry / empty value)

function cleanProtocol(p: string | undefined | null): ProtocolSnapshot {
    const v = (p || '').trim().toLowerCase();
    return v ? v : null;
}

/** ALPN id of the protocol the current document was fetched over, or null if not reported. */
export function getPageProtocol(): ProtocolSnapshot {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return null;
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return cleanProtocol(nav?.nextHopProtocol);
}

/**
 * ALPN id of the most recent same-origin resource fetch whose path starts with `pathPrefix`
 * (default '/api/'), or null if none was observed / the browser did not report one.
 */
export function getLatestResourceProtocol(pathPrefix = '/api/'): ProtocolSnapshot {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByType !== 'function') return null;
    const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    for (let i = entries.length - 1; i >= 0; i--) {
        let url: URL;
        try {
            url = new URL(entries[i].name);
        } catch {
            continue;
        }
        if (url.origin !== location.origin || !url.pathname.startsWith(pathPrefix)) continue;
        const p = cleanProtocol(entries[i].nextHopProtocol);
        if (p) return p;
    }
    return null;
}

/** Human label for an ALPN id. Unknown ids are shown verbatim. */
export function describeProtocol(p: ProtocolSnapshot): string {
    if (!p) return 'Not reported by browser';
    if (p === 'h3' || p.startsWith('h3-')) return `HTTP/3 over QUIC (${p})`;
    if (p === 'h2') return 'HTTP/2 (h2)';
    if (p === 'h2c') return 'HTTP/2 cleartext (h2c)';
    if (p === 'http/1.1') return 'HTTP/1.1';
    if (p === 'http/1.0') return 'HTTP/1.0';
    return p;
}

/** Subscribe to new resource timing entries (for useSyncExternalStore). */
export function subscribeResourceTiming(onChange: () => void): () => void {
    if (typeof PerformanceObserver === 'undefined') return () => {};
    let observer: PerformanceObserver | null = null;
    try {
        observer = new PerformanceObserver(() => onChange());
        observer.observe({ type: 'resource', buffered: false });
    } catch {
        return () => {};
    }
    return () => observer?.disconnect();
}

export interface WebRTCTransportInfo {
    localCandidateType: string | null;  // host | srflx | prflx | relay
    remoteCandidateType: string | null;
    protocol: string | null;            // udp | tcp
    rttMs: number | null;               // currentRoundTripTime of the selected pair
}

/** Reads the selected ICE candidate pair of a connected RTCPeerConnection. */
export async function getWebRTCTransportInfo(pc: RTCPeerConnection): Promise<WebRTCTransportInfo | null> {
    let stats: RTCStatsReport;
    try {
        stats = await pc.getStats();
    } catch {
        return null;
    }
    type Rec = Record<string, unknown> & { id: string; type: string };
    const byId = new Map<string, Rec>();
    stats.forEach((s: Rec) => byId.set(s.id, s));

    let pair: Rec | undefined;
    for (const s of byId.values()) {
        if (s.type === 'transport' && typeof s.selectedCandidatePairId === 'string') {
            pair = byId.get(s.selectedCandidatePairId);
            if (pair) break;
        }
    }
    if (!pair) {
        // Firefox exposes `selected` on the pair instead of a transport stat.
        for (const s of byId.values()) {
            if (s.type === 'candidate-pair' && (s.selected === true || (s.nominated === true && s.state === 'succeeded'))) {
                pair = s;
                break;
            }
        }
    }
    if (!pair) return null;
    const local = typeof pair.localCandidateId === 'string' ? byId.get(pair.localCandidateId) : undefined;
    const remote = typeof pair.remoteCandidateId === 'string' ? byId.get(pair.remoteCandidateId) : undefined;
    const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
    const rtt = typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : null;
    return {
        localCandidateType: str(local?.candidateType),
        remoteCandidateType: str(remote?.candidateType),
        protocol: str(local?.protocol),
        rttMs: rtt,
    };
}

export function describeWebRTCTransport(info: WebRTCTransportInfo | null): string {
    if (!info) return 'WebRTC data channel';
    const types = [info.localCandidateType, info.remoteCandidateType];
    const path = types.includes('relay')
        ? 'relayed via TURN'
        : types.every(t => t === 'host')
            ? 'direct, local network'
            : types.some(t => t === null) ? 'direct' : 'direct, NAT traversal';
    const parts = [path];
    if (info.protocol) parts.push(info.protocol.toUpperCase());
    if (info.rttMs !== null) parts.push(`RTT ${info.rttMs} ms`);
    return `WebRTC data channel (${parts.join(', ')})`;
}
