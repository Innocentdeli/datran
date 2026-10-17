import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { ApiError, UploadCancelledError, uploadDocument, type UploadProgress, type UploadSuccess } from '../api/client';
import { LinkActions } from '../components/LinkActions';
import type { HistoryItem } from '../storage/history';
import type { Settings } from '../storage/settings';
import { colors, formatBytes, shared } from '../theme';

interface UploadScreenProps {
    settings: Settings;
    signedIn: boolean;
    onUploaded: (item: HistoryItem) => void;
    onOpenSettings: () => void;
}

type UploadState =
    | { kind: 'idle' }
    | { kind: 'uploading'; filename: string; size?: number; progress: UploadProgress | null }
    | { kind: 'done'; filename: string; result: UploadSuccess }
    | { kind: 'error'; message: string };

export function UploadScreen({ settings, signedIn, onUploaded, onOpenSettings }: UploadScreenProps) {
    const [state, setState] = useState<UploadState>({ kind: 'idle' });
    const abortRef = useRef<AbortController | null>(null);

    // Cancel an in-flight upload if the screen unmounts.
    useEffect(() => () => abortRef.current?.abort(), []);

    const canUpload = settings.anonymousUploads || signedIn;
    const busy = state.kind === 'uploading';

    const pickAndUpload = async () => {
        let picked: DocumentPicker.DocumentPickerResult;
        try {
            picked = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
        } catch (err) {
            setState({ kind: 'error', message: `Could not open the file picker: ${err instanceof Error ? err.message : String(err)}` });
            return;
        }
        if (picked.canceled) return;
        const asset = picked.assets[0];
        if (!asset) return;

        const controller = new AbortController();
        abortRef.current = controller;
        setState({ kind: 'uploading', filename: asset.name, size: asset.size, progress: null });

        try {
            const result = await uploadDocument({
                serverUrl: settings.serverUrl,
                asset,
                signal: controller.signal,
                onProgress: (progress) =>
                    setState((s) => (s.kind === 'uploading' ? { ...s, progress } : s)),
            });
            setState({ kind: 'done', filename: asset.name, result });
            onUploaded({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                filename: asset.name,
                size: asset.size,
                mimeType: asset.mimeType,
                link: result.link,
                serverUrl: settings.serverUrl,
                uploadedAt: Date.now(),
                stats: result.stats,
            });
        } catch (err) {
            if (err instanceof UploadCancelledError) {
                setState({ kind: 'idle' });
            } else {
                const message = err instanceof ApiError || err instanceof Error ? err.message : String(err);
                setState({ kind: 'error', message });
            }
        } finally {
            if (abortRef.current === controller) abortRef.current = null;
        }
    };

    const cancel = () => abortRef.current?.abort();

    const percent =
        state.kind === 'uploading' && state.progress && state.progress.totalBytes > 0
            ? Math.min(100, Math.round((state.progress.bytesSent / state.progress.totalBytes) * 100))
            : null;

    return (
        <View>
            <Text style={shared.screenTitle}>
                DIOCOM<Text style={{ color: colors.accent }}>{'//'}</Text>MOBILE
            </Text>
            <Text style={shared.screenSubtitle}>Upload and share</Text>

            <View style={shared.card}>
                <Text style={shared.cardLabel}>UPLOAD</Text>
                <Text style={[shared.body, styles.spaced]}>
                    Pick a file to upload to {settings.serverUrl}. You get a share link when it is stored.
                </Text>

                {!canUpload ? (
                    <TouchableOpacity onPress={onOpenSettings} accessibilityRole="button">
                        <Text style={styles.warning}>
                            Anonymous uploads are turned off and mobile sign-in is not available yet. Open settings to
                            enable anonymous uploads.
                        </Text>
                    </TouchableOpacity>
                ) : null}

                {state.kind === 'uploading' ? (
                    <View>
                        <Text style={styles.filename} numberOfLines={1}>
                            {state.filename}
                        </Text>
                        <Text style={styles.meta}>
                            {formatBytes(state.size)}
                            {percent !== null ? ` · ${percent}%` : ' · starting…'}
                        </Text>
                        <View style={styles.progressTrack}>
                            <View style={[styles.progressFill, { width: `${percent ?? 0}%` }]} />
                        </View>
                        <View style={styles.row}>
                            <ActivityIndicator color={colors.accent} />
                            <TouchableOpacity style={[shared.secondaryButton, styles.flex]} onPress={cancel} accessibilityRole="button">
                                <Text style={shared.secondaryButtonText}>Cancel upload</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                ) : (
                    <TouchableOpacity
                        style={[shared.button, (!canUpload || busy) && shared.disabled]}
                        onPress={pickAndUpload}
                        disabled={!canUpload || busy}
                        accessibilityRole="button"
                    >
                        <Text style={shared.buttonText}>CHOOSE FILE</Text>
                    </TouchableOpacity>
                )}

                {state.kind === 'error' ? <Text style={styles.error}>{state.message}</Text> : null}
            </View>

            {state.kind === 'done' ? (
                <View style={shared.card}>
                    <Text style={[shared.cardLabel, { color: colors.success }]}>UPLOADED</Text>
                    <Text style={styles.filename} numberOfLines={1}>
                        {state.filename}
                    </Text>
                    <Text style={styles.link} selectable numberOfLines={2}>
                        {state.result.link}
                    </Text>
                    {state.result.stats ? (
                        <View style={styles.statsRow}>
                            {state.result.stats.ratio ? <Stat label="STORAGE" value={state.result.stats.ratio} /> : null}
                            {state.result.stats.speed ? <Stat label="SPEED" value={state.result.stats.speed} /> : null}
                        </View>
                    ) : null}
                    <LinkActions link={state.result.link} filename={state.filename} />
                </View>
            ) : null}
        </View>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <View style={styles.stat}>
            <Text style={styles.statValue}>{value}</Text>
            <Text style={styles.statLabel}>{label}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    spaced: {
        marginBottom: 16,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    flex: {
        flex: 1,
    },
    filename: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    meta: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 2,
        marginBottom: 10,
    },
    progressTrack: {
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.border,
        overflow: 'hidden',
        marginBottom: 14,
    },
    progressFill: {
        height: '100%',
        backgroundColor: colors.accent,
    },
    warning: {
        color: colors.accent,
        fontSize: 13,
        lineHeight: 18,
        marginBottom: 16,
    },
    error: {
        color: colors.danger,
        fontSize: 13,
        lineHeight: 18,
        marginTop: 14,
    },
    link: {
        color: colors.accent,
        fontSize: 13,
        marginVertical: 10,
    },
    statsRow: {
        flexDirection: 'row',
        gap: 8,
        marginBottom: 12,
    },
    stat: {
        flex: 1,
        backgroundColor: colors.accentSoft,
        borderRadius: 10,
        padding: 10,
    },
    statValue: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
    },
    statLabel: {
        color: colors.textMuted,
        fontSize: 10,
        letterSpacing: 1,
        marginTop: 2,
    },
});
