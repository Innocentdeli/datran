'use client';

import { useCallback, useEffect, useState } from 'react';
import type { PublicFile } from '@/db/files';
import { downloadFile, encryptionFormatOf, resolveViewSource, streamUrl, subscribeE2EErrors, type ViewSource } from '@/lib/crypto/e2eClient';

interface SourceState {
    /** Which request this state belongs to (fileId + retry); stale states read as loading. */
    key: string;
    src: string | null;
    mode: ViewSource['mode'] | null;
    error: string | null;
}

/**
 * Resolves a playable/viewable URL for a share, decrypting end-to-end encrypted files (streaming through the
 * Service Worker for DCE2, in memory for legacy v1 / when no worker is available). Also exposes `download()`.
 */
export function useE2ESource(fileId: string, metadata?: PublicFile, retry = 0) {
    const isEncrypted = !!encryptionFormatOf(metadata);
    const requestKey = `${fileId}:${retry}`;
    const [state, setState] = useState<SourceState>({ key: '', src: null, mode: null, error: null });

    useEffect(() => {
        if (!isEncrypted) return;
        let cancelled = false;
        let revoke: (() => void) | undefined;
        resolveViewSource(fileId, metadata).then(
            (r) => {
                if (cancelled) {
                    r.revoke?.();
                    return;
                }
                revoke = r.revoke;
                setState({ key: requestKey, src: r.src, mode: r.mode, error: null });
            },
            (err: unknown) => {
                if (!cancelled) setState({ key: requestKey, src: null, mode: null, error: err instanceof Error ? err.message : String(err) });
            },
        );
        const unsubscribe = subscribeE2EErrors(fileId, (message) => {
            if (!cancelled) setState((s) => ({ ...s, key: requestKey, error: message }));
        });
        return () => {
            cancelled = true;
            unsubscribe();
            revoke?.();
        };
    }, [fileId, metadata, isEncrypted, requestKey]);

    const download = useCallback(() => downloadFile(fileId, metadata), [fileId, metadata]);

    if (!isEncrypted) {
        return { src: streamUrl(fileId), mode: 'plain' as const, error: null, loading: false, isEncrypted, download };
    }
    const current = state.key === requestKey;
    return {
        src: current ? state.src : null,
        mode: current ? state.mode : null,
        error: current ? state.error : null,
        loading: !current,
        isEncrypted,
        download,
    };
}
