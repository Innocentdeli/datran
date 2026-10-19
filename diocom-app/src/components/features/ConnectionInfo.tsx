'use client';

import { useSyncExternalStore } from 'react';
import { Activity, Lock, Server } from 'lucide-react';
import {
    describeProtocol,
    getLatestResourceProtocol,
    getPageProtocol,
    subscribeResourceTiming,
    type ProtocolSnapshot,
} from '@/lib/network/transportInfo';

const noopSubscribe = () => () => {};
const serverSnapshot = (): ProtocolSnapshot => null;

/** Measured protocol of the current page load (nextHopProtocol of the navigation entry). */
export function usePageProtocol(): ProtocolSnapshot {
    return useSyncExternalStore(noopSubscribe, getPageProtocol, serverSnapshot);
}

/** Measured protocol of the most recent same-origin /api/ request; updates as requests complete. */
export function useApiProtocol(): ProtocolSnapshot {
    return useSyncExternalStore(subscribeResourceTiming, getLatestResourceProtocol, serverSnapshot);
}

function useIsSecureContext(): boolean | null {
    return useSyncExternalStore(
        noopSubscribe,
        () => (typeof window === 'undefined' ? null : window.isSecureContext),
        () => null,
    );
}

/** Compact one-line label, e.g. for a footer. */
export function PageProtocolBadge({ className = '' }: { className?: string }) {
    const page = usePageProtocol();
    return (
        <span className={className} title="Protocol this page was loaded over, as reported by the browser (PerformanceNavigationTiming.nextHopProtocol)">
            {page ? describeProtocol(page) : 'Protocol: not reported'}
        </span>
    );
}

/**
 * Card listing measured connection facts. Every row comes from a browser API; when the
 * browser does not report a value we say so instead of guessing.
 */
export default function ConnectionInfo({ title = 'Connection' }: { title?: string }) {
    const page = usePageProtocol();
    const api = useApiProtocol();
    const secure = useIsSecureContext();

    const rows: { icon: typeof Activity; label: string; value: string }[] = [
        { icon: Activity, label: 'Page loaded over', value: describeProtocol(page) },
        { icon: Server, label: 'Latest API request', value: api ? describeProtocol(api) : 'No API request measured yet' },
        { icon: Lock, label: 'Secure context (TLS)', value: secure === null ? 'Unknown' : secure ? 'Yes' : 'No' },
    ];

    return (
        <div className="w-full glass p-5 border border-white/10 rounded-3xl bg-black/40">
            <h3 className="font-bold text-white text-sm tracking-tight mb-3">{title}</h3>
            <dl className="flex flex-col gap-2">
                {rows.map(({ icon: Icon, label, value }) => (
                    <div key={label} className="flex items-center justify-between gap-3 text-xs">
                        <dt className="flex items-center gap-2 text-gray-400">
                            <Icon className="w-3.5 h-3.5" />
                            {label}
                        </dt>
                        <dd className="font-mono text-gray-200 text-right">{value}</dd>
                    </div>
                ))}
            </dl>
            <p className="mt-3 text-[11px] text-gray-400 leading-relaxed">
                Reported by your browser for this connection. Browsers switch to HTTP/3 after
                seeing the server&apos;s Alt-Svc header, so a first visit often shows HTTP/2.
            </p>
        </div>
    );
}
