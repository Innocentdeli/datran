import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { fetchMyFiles, type RemoteFile } from '../api/client';
import { LinkActions } from '../components/LinkActions';
import type { HistoryItem } from '../storage/history';
import { colors, formatBytes, shared } from '../theme';

interface InboxScreenProps {
    items: HistoryItem[];
    onRemove: (id: string) => void;
    onClear: () => void;
    signedIn: boolean;
    serverUrl: string;
}

type Remote = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; files: RemoteFile[] } | { kind: 'error'; message: string };

/** The signed-in user's uploads on the server (GET /api/mobile/files), from any device or the web. */
function AccountFiles({ serverUrl }: { serverUrl: string }) {
    const [state, setState] = useState<Remote>({ kind: 'loading' });
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let alive = true;
        fetchMyFiles(serverUrl).then(
            (files) => {
                if (alive) setState({ kind: 'ok', files });
            },
            (err: unknown) => {
                if (alive) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
            },
        );
        return () => {
            alive = false;
        };
    }, [serverUrl, reloadKey]);

    const load = useCallback(() => {
        setState({ kind: 'loading' });
        setReloadKey((k) => k + 1);
    }, []);

    return (
        <View>
            <View style={styles.sectionHeader}>
                <Text style={shared.cardLabel}>ON YOUR ACCOUNT</Text>
                <TouchableOpacity onPress={load} disabled={state.kind === 'loading'} accessibilityRole="button" accessibilityLabel="Refresh account uploads" hitSlop={8}>
                    <Text style={styles.remove}>Refresh</Text>
                </TouchableOpacity>
            </View>
            {state.kind === 'loading' || state.kind === 'idle' ? (
                <View style={shared.card}>
                    <ActivityIndicator color={colors.accent} />
                </View>
            ) : null}
            {state.kind === 'error' ? (
                <View style={shared.card}>
                    <Text style={[shared.body, { color: colors.danger }]}>{state.message}</Text>
                </View>
            ) : null}
            {state.kind === 'ok' && state.files.length === 0 ? (
                <View style={shared.card}>
                    <Text style={shared.body}>No files on your account yet.</Text>
                </View>
            ) : null}
            {state.kind === 'ok'
                ? state.files.map((f) => (
                      <View key={f.share_id} style={shared.card}>
                          <Text style={styles.filename} numberOfLines={1}>
                              {f.original_name}
                          </Text>
                          <Text style={styles.meta}>
                              {formatBytes(f.file_size)} · {new Date(f.created_at).toLocaleString()} · {f.downloads} download{f.downloads === 1 ? '' : 's'}
                              {f.expires_at ? ` · expires ${new Date(f.expires_at).toLocaleDateString()}` : ''}
                          </Text>
                          <Text style={styles.link} selectable numberOfLines={1}>
                              {f.link}
                          </Text>
                          <LinkActions link={f.link} filename={f.original_name} />
                      </View>
                  ))
                : null}
            <Text style={[shared.cardLabel, styles.localLabel]}>ON THIS DEVICE</Text>
        </View>
    );
}

/**
 * Uploads made from this device (AsyncStorage history), plus — when signed in — the account's files on the server.
 */
export function InboxScreen({ items, onRemove, onClear, signedIn, serverUrl }: InboxScreenProps) {
    return (
        <View>
            <Text style={shared.screenTitle}>
                MY<Text style={{ color: colors.accent }}>{'//'}</Text>UPLOADS
            </Text>
            <Text style={shared.screenSubtitle}>{signedIn ? 'Your account and this device' : 'Uploaded from this device'}</Text>

            {signedIn ? <AccountFiles serverUrl={serverUrl} /> : null}

            {items.length === 0 ? (
                <View style={shared.card}>
                    <Text style={shared.body}>No uploads yet. Files you upload appear here with their share links.</Text>
                </View>
            ) : (
                <>
                    {items.map((item) => (
                        <View key={item.id} style={shared.card}>
                            <View style={styles.header}>
                                <Text style={styles.filename} numberOfLines={1}>
                                    {item.filename}
                                </Text>
                                <TouchableOpacity
                                    onPress={() => onRemove(item.id)}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Remove ${item.filename} from history`}
                                    hitSlop={8}
                                >
                                    <Text style={styles.remove}>Remove</Text>
                                </TouchableOpacity>
                            </View>
                            <Text style={styles.meta}>
                                {formatBytes(item.size)} · {new Date(item.uploadedAt).toLocaleString()}
                                {item.stats?.ratio ? ` · ${item.stats.ratio}` : ''}
                            </Text>
                            <Text style={styles.link} selectable numberOfLines={1}>
                                {item.link}
                            </Text>
                            <LinkActions link={item.link} filename={item.filename} />
                        </View>
                    ))}
                    <TouchableOpacity style={shared.secondaryButton} onPress={onClear} accessibilityRole="button">
                        <Text style={[shared.secondaryButtonText, { color: colors.danger }]}>Clear history</Text>
                    </TouchableOpacity>
                    <Text style={styles.footnote}>
                        Removing an entry only forgets it on this device; the file and its link stay on the server until
                        they expire.
                    </Text>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    sectionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    localLabel: {
        marginTop: 8,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    filename: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        flex: 1,
    },
    remove: {
        color: colors.textFaint,
        fontSize: 12,
    },
    meta: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 4,
    },
    link: {
        color: colors.accent,
        fontSize: 13,
        marginVertical: 10,
    },
    footnote: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 12,
        textAlign: 'center',
    },
});
