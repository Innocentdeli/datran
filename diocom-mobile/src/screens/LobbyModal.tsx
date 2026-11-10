import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';

import {
    addFilesToLobby,
    completeLobby,
    createLobby,
    fetchLobbyState,
    joinLobby,
    uploadDocument,
    type LobbyFileItem,
    type LobbyState,
} from '../api/client';
import { colors, formatBytes, radius, space } from '../theme';
import {
    Badge,
    Button,
    Card,
    FileIcon,
    haptic,
    Icon,
    IconButton,
    Notice,
    RadarPulse,
    TextField,
    useToast,
} from '../ui';

interface LobbyModalProps {
    visible: boolean;
    serverUrl: string;
    onClose: () => void;
    onFilesReceived?: (files: { name: string; link: string; size: number }[]) => void;
}

type LobbyMode = 'select' | 'host' | 'join';

export function LobbyModal({ visible, serverUrl, onClose, onFilesReceived }: LobbyModalProps) {
    const toast = useToast();
    const [mode, setMode] = useState<LobbyMode>('select');
    const [code, setCode] = useState('');
    const [joinInput, setJoinInput] = useState('');
    const [lobbyToken, setLobbyToken] = useState<string | undefined>(undefined);
    const [lobbyState, setLobbyState] = useState<LobbyState | null>(null);
    const [busy, setBusy] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const activeCode = mode === 'host' ? code : joinInput.trim().toUpperCase();

    // Reset all state on exit
    const handleClose = () => {
        if (pollTimerRef.current) clearInterval(pollTimerRef.current);
        setMode('select');
        setCode('');
        setJoinInput('');
        setLobbyToken(undefined);
        setLobbyState(null);
        setBusy(false);
        setUploading(false);
        setErrorMsg(null);
        onClose();
    };

    // Polling effect when in a lobby
    const pollLobby = useCallback(async () => {
        if (!activeCode || activeCode.length < 4) return;
        try {
            const state = await fetchLobbyState(serverUrl, activeCode, lobbyToken);
            setLobbyState(state);
            if (state.status === 'expired') {
                setErrorMsg('This lobby has expired.');
                if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            }
        } catch (err) {
            // Transient network errors during polling are ignored
        }
    }, [activeCode, lobbyToken, serverUrl]);

    useEffect(() => {
        if ((mode === 'host' && code) || (mode === 'join' && lobbyState?.status === 'active')) {
            pollTimerRef.current = setInterval(pollLobby, 2500);
            return () => {
                if (pollTimerRef.current) clearInterval(pollTimerRef.current);
            };
        }
    }, [mode, code, lobbyState?.status, pollLobby]);

    // Host: Create Room
    const handleCreateLobby = async () => {
        haptic.medium();
        setBusy(true);
        setErrorMsg(null);
        try {
            const res = await createLobby(serverUrl);
            setCode(res.code);
            setLobbyToken(res.token);
            setMode('host');
            setLobbyState({
                status: 'waiting',
                code: res.code,
                expiresAt: res.expiresAt,
                role: 'creator',
                files: [],
            });
            haptic.success();
        } catch (err) {
            haptic.error();
            setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    // Joiner: Enter Code
    const handleJoinLobby = async () => {
        const targetCode = joinInput.trim().toUpperCase();
        if (targetCode.length < 4) return;
        haptic.medium();
        setBusy(true);
        setErrorMsg(null);
        try {
            const res = await joinLobby(serverUrl, targetCode);
            setLobbyToken(res.token);
            setMode('join');
            // Fetch initial state
            const state = await fetchLobbyState(serverUrl, targetCode, res.token);
            setLobbyState(state);
            haptic.success();
            toast.show('Connected to live room!');
        } catch (err) {
            haptic.error();
            setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    // Host: Pick and beam files
    const handlePickAndSendFiles = async () => {
        if (!code) return;
        haptic.light();
        try {
            const picked = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
                multiple: true,
            });
            if (picked.canceled || !picked.assets?.length) return;

            setUploading(true);
            const uploadedShareIds: string[] = [];

            for (const asset of picked.assets) {
                const res = await uploadDocument({
                    serverUrl,
                    asset,
                    expiresInHours: 24,
                });
                const shareId = res.link.split('/').pop() || '';
                if (shareId) uploadedShareIds.push(shareId);
            }

            if (uploadedShareIds.length > 0) {
                const updatedFiles = await addFilesToLobby(serverUrl, code, uploadedShareIds, lobbyToken);
                setLobbyState((prev) => (prev ? { ...prev, files: updatedFiles } : prev));
                haptic.success();
                toast.show(`${uploadedShareIds.length} file(s) dropped into room!`);
            }
        } catch (err) {
            haptic.error();
            Alert.alert('Transfer Error', err instanceof Error ? err.message : String(err));
        } finally {
            setUploading(false);
        }
    };

    // Receiver: Accept files
    const handleImportReceivedFiles = (items: LobbyFileItem[]) => {
        if (!items.length) return;
        haptic.medium();
        const results = items.map((f) => ({
            name: f.name,
            link: `${serverUrl.replace(/\/+$/, '')}/v1/${f.shareId}`,
            size: f.size,
        }));
        onFilesReceived?.(results);
        toast.show(`${results.length} file(s) saved to Transfers!`);
        handleClose();
    };

    // Complete / Close Room
    const handleEndLobby = async () => {
        if (activeCode) {
            try {
                await completeLobby(serverUrl, activeCode, lobbyToken);
            } catch {}
        }
        handleClose();
    };

    const copyCode = async () => {
        if (!code) return;
        await Clipboard.setStringAsync(code);
        haptic.light();
        toast.show('Room code copied to clipboard!');
    };

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
            <View style={styles.backdrop}>
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                <View style={styles.sheet}>
                    {/* Header */}
                    <View style={styles.header}>
                        <View style={styles.iconWrap}>
                            <Icon name="flash" size={24} color={colors.primary} />
                        </View>
                        <Text style={styles.title}>Live Lobby</Text>
                        <Text style={styles.subtitle}>
                            Real-time file exchange with anyone in the room via a 6-digit code
                        </Text>
                        <Pressable style={styles.closeBtn} onPress={handleClose}>
                            <Icon name="close" size={20} color={colors.textMuted} />
                        </Pressable>
                    </View>

                    {errorMsg ? (
                        <View style={styles.errorWrap}>
                            <Notice tone="danger" message={errorMsg} />
                        </View>
                    ) : null}

                    {/* MODE 1: SELECT (Host vs Join) */}
                    {mode === 'select' ? (
                        <View style={styles.selectGrid}>
                            <Pressable
                                onPress={handleCreateLobby}
                                style={({ pressed }) => [styles.modeCard, pressed && styles.modeCardPressed]}
                            >
                                <View style={[styles.modeIconWrap, { backgroundColor: colors.primarySoft }]}>
                                    <Icon name="cloud-upload" size={28} color={colors.primary} />
                                </View>
                                <Text style={styles.modeTitle}>Send Files</Text>
                                <Text style={styles.modeDesc}>Generate a 6-digit room code to drop files</Text>
                                <Button
                                    label="Create Room"
                                    variant="primary"
                                    size="sm"
                                    loading={busy}
                                    onPress={handleCreateLobby}
                                />
                            </Pressable>

                            <Pressable
                                onPress={() => setMode('join')}
                                style={({ pressed }) => [styles.modeCard, pressed && styles.modeCardPressed]}
                            >
                                <View style={[styles.modeIconWrap, { backgroundColor: colors.violetSoft }]}>
                                    <Icon name="download" size={28} color={colors.violet} />
                                </View>
                                <Text style={styles.modeTitle}>Receive Files</Text>
                                <Text style={styles.modeDesc}>Enter a 6-digit code from the sender</Text>
                                <Button
                                    label="Join Room"
                                    variant="secondary"
                                    size="sm"
                                    onPress={() => setMode('join')}
                                />
                            </Pressable>
                        </View>
                    ) : null}

                    {/* MODE 2: JOIN (ENTER CODE) */}
                    {mode === 'join' && (!lobbyState || lobbyState.status === 'waiting') ? (
                        <View style={styles.joinBlock}>
                            <TextField
                                label="6-DIGIT ROOM CODE"
                                value={joinInput}
                                onChangeText={(t) => {
                                    setJoinInput(t.toUpperCase());
                                    setErrorMsg(null);
                                }}
                                placeholder="XXXXXX"
                                autoCapitalize="characters"
                                maxLength={6}
                                autoFocus
                                icon="key-outline"
                                hint="Ask the sender for their 6-character room code."
                            />

                            <View style={styles.btnRow}>
                                <Button
                                    label="Back"
                                    variant="ghost"
                                    size="md"
                                    onPress={() => setMode('select')}
                                />
                                <Button
                                    label="Join Lobby"
                                    icon="arrow-forward-outline"
                                    variant="primary"
                                    size="md"
                                    disabled={joinInput.trim().length < 4}
                                    loading={busy}
                                    onPress={handleJoinLobby}
                                />
                            </View>
                        </View>
                    ) : null}

                    {/* MODE 3: HOST WAITING FOR JOINER */}
                    {mode === 'host' && lobbyState?.status === 'waiting' ? (
                        <View style={styles.waitingBlock}>
                            <RadarPulse
                                size={90}
                                icon="flash"
                                statusText="Waiting for Attendee to Join"
                                subText="Listening on local Wi-Fi / Hotspot"
                            />

                            <View style={styles.codeCard}>
                                <Text style={styles.codeLabel}>YOUR ROOM CODE</Text>
                                <Pressable onPress={copyCode} style={styles.codeRow}>
                                    <Text style={styles.codeDisplay}>{code}</Text>
                                    <View style={styles.copyBtn}>
                                        <Icon name="copy-outline" size={18} color={colors.primary} />
                                    </View>
                                </Pressable>
                                <Text style={styles.codeHint}>Tap code to copy or read aloud to attendee</Text>
                            </View>

                            <Button
                                label="Cancel Room"
                                variant="ghost"
                                size="sm"
                                onPress={handleEndLobby}
                            />
                        </View>
                    ) : null}

                    {/* MODE 4: ACTIVE ROOM (CONNECTED) */}
                    {lobbyState?.status === 'active' || lobbyState?.status === 'transferring' ? (
                        <View style={styles.activeBlock}>
                            <View style={styles.connectedBanner}>
                                <Icon name="wifi" size={16} color={colors.success} />
                                <Text style={styles.connectedText}>Connected · Room: {activeCode}</Text>
                            </View>

                            {/* Files List in Room */}
                            <Text style={styles.sectionHeader}>
                                Files in Room ({lobbyState.files.length})
                            </Text>

                            <ScrollView style={styles.fileScroll} showsVerticalScrollIndicator={false}>
                                {lobbyState.files.length === 0 ? (
                                    <View style={styles.emptyFiles}>
                                        <Icon name="file-tray-outline" size={32} color={colors.textFaint} />
                                        <Text style={styles.emptyFilesText}>
                                            {mode === 'host'
                                                ? 'Drop files below to beam them to the receiver.'
                                                : 'Waiting for sender to drop files...'}
                                        </Text>
                                    </View>
                                ) : (
                                    lobbyState.files.map((file, idx) => (
                                        <View key={idx} style={styles.fileRow}>
                                            <FileIcon name={file.name} mime={file.mimeType} size={36} />
                                            <View style={styles.fileMeta}>
                                                <Text style={styles.fileName} numberOfLines={1}>
                                                    {file.name}
                                                </Text>
                                                <Text style={styles.fileSize}>{formatBytes(file.size)}</Text>
                                            </View>
                                            <Badge label="Ready" tone="success" />
                                        </View>
                                    ))
                                )}
                            </ScrollView>

                            {/* Action Buttons */}
                            {mode === 'host' ? (
                                <View style={styles.actionBlock}>
                                    <Button
                                        label={uploading ? 'Beaming Files...' : '+ Drop & Beam Files'}
                                        icon="cloud-upload-outline"
                                        variant="primary"
                                        size="lg"
                                        fullWidth
                                        loading={uploading}
                                        onPress={handlePickAndSendFiles}
                                    />
                                    <Button
                                        label="Finish Transfer"
                                        variant="ghost"
                                        size="sm"
                                        onPress={handleEndLobby}
                                    />
                                </View>
                            ) : (
                                <View style={styles.actionBlock}>
                                    <Button
                                        label={`Accept & Save ${lobbyState.files.length} File${lobbyState.files.length === 1 ? '' : 's'}`}
                                        icon="download-outline"
                                        variant="primary"
                                        size="lg"
                                        fullWidth
                                        disabled={lobbyState.files.length === 0}
                                        onPress={() => handleImportReceivedFiles(lobbyState.files)}
                                    />
                                    <Button
                                        label="Leave Room"
                                        variant="ghost"
                                        size="sm"
                                        onPress={handleClose}
                                    />
                                </View>
                            )}
                        </View>
                    ) : null}
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.8)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        padding: space.xl,
        paddingBottom: space.xxxl,
        gap: space.lg,
        maxHeight: '90%',
    },
    header: {
        alignItems: 'center',
        gap: 6,
        position: 'relative',
    },
    iconWrap: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 4,
    },
    title: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '800',
    },
    subtitle: {
        color: colors.textMuted,
        fontSize: 13,
        textAlign: 'center',
        maxWidth: 320,
    },
    closeBtn: {
        position: 'absolute',
        top: 0,
        right: 0,
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
    },
    errorWrap: {
        marginVertical: space.xs,
    },
    selectGrid: {
        flexDirection: 'row',
        gap: space.md,
        paddingVertical: space.sm,
    },
    modeCard: {
        flex: 1,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.xl,
        padding: space.lg,
        alignItems: 'center',
        gap: space.sm,
    },
    modeCardPressed: {
        backgroundColor: colors.surfacePressed,
    },
    modeIconWrap: {
        width: 52,
        height: 52,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 4,
    },
    modeTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    modeDesc: {
        color: colors.textMuted,
        fontSize: 11,
        textAlign: 'center',
        minHeight: 32,
    },
    joinBlock: {
        gap: space.lg,
        paddingVertical: space.sm,
    },
    btnRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: space.md,
    },
    waitingBlock: {
        alignItems: 'center',
        gap: space.lg,
        paddingVertical: space.md,
    },
    pulseRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    waitingText: {
        color: colors.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    codeCard: {
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        borderRadius: radius.xl,
        padding: space.xl,
        alignItems: 'center',
        gap: space.xs,
        width: '100%',
    },
    codeLabel: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '700',
        letterSpacing: 1.5,
    },
    codeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        marginVertical: space.xs,
    },
    codeDisplay: {
        color: colors.text,
        fontSize: 38,
        fontWeight: '900',
        letterSpacing: 6,
        fontFamily: 'monospace',
    },
    copyBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    codeHint: {
        color: colors.textMuted,
        fontSize: 11,
    },
    activeBlock: {
        gap: space.md,
    },
    connectedBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        paddingVertical: 8,
        borderRadius: radius.md,
        backgroundColor: colors.successSoft,
        borderWidth: 1,
        borderColor: 'rgba(16,185,129,0.25)',
    },
    connectedText: {
        color: colors.success,
        fontSize: 13,
        fontWeight: '700',
    },
    sectionHeader: {
        color: colors.textMuted,
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.8,
        marginTop: space.xs,
    },
    fileScroll: {
        maxHeight: 200,
        minHeight: 100,
    },
    emptyFiles: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: space.xl,
        gap: space.xs,
    },
    emptyFilesText: {
        color: colors.textFaint,
        fontSize: 13,
        textAlign: 'center',
        maxWidth: 240,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
    },
    fileMeta: {
        flex: 1,
        minWidth: 0,
    },
    fileName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    fileSize: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 2,
    },
    actionBlock: {
        gap: space.sm,
        marginTop: space.sm,
    },
});
