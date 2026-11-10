import { useEffect, useState, useRef } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { uploadDocument } from '../api/client';
import { recordPeerTransfer } from '../storage/savedPeers';
import { colors, radius, space } from '../theme';
import {
    Badge,
    Button,
    Card,
    haptic,
    Icon,
    Notice,
    RadarPulse,
    TextField,
    useToast,
} from '../ui';
import { QRScannerModal } from '../components/QRScannerModal';

interface PairModalProps {
    visible: boolean;
    serverUrl: string;
    onClose: () => void;
    onFilesReceived?: (links: string[]) => void;
}

export function PairModal({ visible, serverUrl, onClose, onFilesReceived }: PairModalProps) {
    const toast = useToast();
    const [pairInput, setPairInput] = useState('');
    const [busy, setBusy] = useState(false);
    const [uploadingToPc, setUploadingToPc] = useState(false);
    const [showScanner, setShowScanner] = useState(false);
    const [sessionData, setSessionData] = useState<{ status: string; fileIds: string[] } | null>(null);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);
    const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

    const extractSessionId = (input: string): string => {
        const trimmed = input.trim();
        const match = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        return match ? match[0] : trimmed;
    };

    // Live polling when paired to detect files dropped on desktop
    useEffect(() => {
        const sessionId = extractSessionId(pairInput);
        if (!visible || !sessionId || !sessionData) {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
            return;
        }

        const pollSession = async () => {
            try {
                const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/qr/${sessionId}`);
                if (!res.ok) return;
                const data = await res.json();
                if (data.status === 'expired') {
                    setErrorMsg('This pairing session has expired.');
                    return;
                }
                setSessionData((prev) => {
                    const nextFiles = Array.isArray(data.fileIds) ? data.fileIds : [];
                    if (prev && JSON.stringify(prev.fileIds) === JSON.stringify(nextFiles) && prev.status === data.status) {
                        return prev;
                    }
                    return { status: data.status, fileIds: nextFiles };
                });
            } catch {
                // Ignore transient network errors during background poll
            }
        };

        pollIntervalRef.current = setInterval(pollSession, 2000);
        return () => {
            if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        };
    }, [visible, pairInput, sessionData?.status, serverUrl]);

    const handleAutoConnect = async (rawInput: string) => {
        const sessionId = extractSessionId(rawInput);
        if (!sessionId) return;
        setBusy(true);
        setErrorMsg(null);

        try {
            const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/qr/${sessionId}`);
            if (!res.ok) throw new Error('Pairing session not found or expired');
            const data = await res.json();
            if (data.status === 'expired') throw new Error('This pairing session has expired');

            const initialFiles = Array.isArray(data.fileIds) ? data.fileIds : [];
            setSessionData({ status: 'paired', fileIds: initialFiles });
            haptic.success();

            await fetch(`${serverUrl.replace(/\/+$/, '')}/api/qr/${sessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'paired' }),
            });
            await recordPeerTransfer({
                id: `desktop-pair-${sessionId}`,
                name: 'Desktop PC (Paired)',
                type: 'desktop',
                serverUrl,
            });
            toast.show('Device paired with Desktop!');
        } catch (err) {
            haptic.error();
            setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const handleConnect = async () => {
        const sessionId = extractSessionId(pairInput);
        if (!sessionId) return;
        haptic.light();
        setBusy(true);
        setErrorMsg(null);

        try {
            const res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/qr/${sessionId}`);
            if (!res.ok) throw new Error('Pairing session not found or expired');
            const data = await res.json();
            if (data.status === 'expired') throw new Error('This pairing session has expired');

            const initialFiles = Array.isArray(data.fileIds) ? data.fileIds : [];
            setSessionData({ status: 'paired', fileIds: initialFiles });
            haptic.success();

            // Mark session as paired
            await fetch(`${serverUrl.replace(/\/+$/, '')}/api/qr/${sessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'paired' }),
            });
            await recordPeerTransfer({
                id: `desktop-pair-${sessionId}`,
                name: 'Desktop PC (Paired)',
                type: 'desktop',
                serverUrl,
            });
            toast.show('Device paired with Desktop!');
        } catch (err) {
            haptic.error();
            setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    const handleAccept = async () => {
        const sessionId = extractSessionId(pairInput);
        if (!sessionId) return;

        if (!sessionData?.fileIds?.length) {
            haptic.warning();
            toast.show('No files from desktop yet. Drop files on desktop or beam from this phone below.', 'info');
            return;
        }

        haptic.medium();
        setBusy(true);

        try {
            // Mark session as complete
            await fetch(`${serverUrl.replace(/\/+$/, '')}/api/qr/${sessionId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'complete' }),
            });

            const links = sessionData.fileIds.map(
                (id) => `${serverUrl.replace(/\/+$/, '')}/v1/${id}`,
            );

            onFilesReceived?.(links);
            haptic.success();
            toast.show(`${links.length} paired file${links.length > 1 ? 's' : ''} added to transfers!`);
            handleClose();
        } catch (err) {
            haptic.error();
            toast.show(`Could not complete pairing: ${err instanceof Error ? err.message : String(err)}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    // Phone -> Desktop: Send Photos
    const handleSendPhotosToPc = async () => {
        const sessionId = extractSessionId(pairInput);
        if (!sessionId) return;

        try {
            const res = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images', 'videos'],
                quality: 1,
            });
            if (res.canceled || !res.assets[0]) return;

            setUploadingToPc(true);
            const asset = res.assets[0];
            const upRes = await uploadDocument({
                serverUrl,
                asset: {
                    uri: asset.uri,
                    name: asset.fileName || `photo_${Date.now()}.${asset.uri.split('.').pop() || 'jpg'}`,
                    size: asset.fileSize ?? 0,
                    mimeType: asset.mimeType ?? 'image/jpeg',
                    lastModified: Date.now(),
                } as DocumentPicker.DocumentPickerAsset,
                expiresInHours: 24,
            });

            const shareId = upRes.link.split('/').pop() || '';
            if (shareId) {
                await fetch(`${serverUrl.replace(/\/+$/, '')}/api/qr/${sessionId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileIds: [shareId] }),
                });
                haptic.success();
                toast.show('Photo sent to your desktop screen!');
            }
        } catch (err) {
            haptic.error();
            Alert.alert('Transfer Failed', err instanceof Error ? err.message : String(err));
        } finally {
            setUploadingToPc(false);
        }
    };

    // Phone -> Desktop: Send Documents
    const handleSendDocumentToPc = async () => {
        const sessionId = extractSessionId(pairInput);
        if (!sessionId) return;

        try {
            const res = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
            });
            if (res.canceled || !res.assets?.[0]) return;

            setUploadingToPc(true);
            const asset = res.assets[0];
            const upRes = await uploadDocument({
                serverUrl,
                asset,
                expiresInHours: 24,
            });

            const shareId = upRes.link.split('/').pop() || '';
            if (shareId) {
                await fetch(`${serverUrl.replace(/\/+$/, '')}/api/qr/${sessionId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fileIds: [shareId] }),
                });
                haptic.success();
                toast.show('File sent to your desktop screen!');
            }
        } catch (err) {
            haptic.error();
            Alert.alert('Transfer Failed', err instanceof Error ? err.message : String(err));
        } finally {
            setUploadingToPc(false);
        }
    };

    const handleClose = () => {
        if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
        setPairInput('');
        setSessionData(null);
        setErrorMsg(null);
        setBusy(false);
        setUploadingToPc(false);
        onClose();
    };

    const hasFiles = Boolean(sessionData?.fileIds?.length);

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
            <View style={styles.backdrop}>
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                <View style={styles.sheet}>
                    <View style={styles.header}>
                        <View style={styles.iconWrap}>
                            <Icon name="qr-code-outline" size={24} color={colors.primary} />
                        </View>
                        <Text style={styles.title}>Pair with Desktop</Text>
                        <Text style={styles.subtitle}>
                            Instantly sync and transfer files with your desktop browser
                        </Text>
                        <Pressable style={styles.closeBtn} onPress={handleClose}>
                            <Icon name="close" size={20} color={colors.textMuted} />
                        </Pressable>
                    </View>

                    <RadarPulse
                        size={80}
                        icon="qr-code-outline"
                        statusText={sessionData ? "Phone Connected to Desktop" : "Desktop Sync Radar"}
                        subText={sessionData ? "Active bidirectional LAN sync" : "Open /pair on your computer to beam files directly"}
                    />

                    {sessionData ? (
                        <View style={styles.readyBlock}>
                            <View style={styles.statusBadgeRow}>
                                <Badge label="Connected to Desktop" tone="primary" icon="wifi" />
                                <Badge
                                    label={hasFiles ? `${sessionData.fileIds.length} file(s) available` : '0 files ready'}
                                    tone={hasFiles ? 'success' : 'neutral'}
                                />
                            </View>

                            {/* Section 1: Accept Incoming from Desktop */}
                            <Card style={styles.actionCard}>
                                <Text style={styles.actionCardTitle}>Incoming from Desktop</Text>
                                <Text style={styles.actionCardDesc}>
                                    {hasFiles
                                        ? `${sessionData.fileIds.length} file(s) received from desktop ready to download.`
                                        : 'Drop files on your desktop /pair screen to receive them on this phone.'}
                                </Text>
                                <Button
                                    label={
                                        hasFiles
                                            ? `Accept & Add to Transfers (${sessionData.fileIds.length})`
                                            : 'Accept & Add to Transfers'
                                    }
                                    icon="download-outline"
                                    variant={hasFiles ? 'primary' : 'tonal'}
                                    size="md"
                                    fullWidth
                                    loading={busy}
                                    onPress={handleAccept}
                                />
                            </Card>

                            {/* Section 2: Send from Phone to Desktop */}
                            <Card style={styles.actionCard}>
                                <Text style={styles.actionCardTitle}>Send Files to Desktop</Text>
                                <Text style={styles.actionCardDesc}>
                                    Select media or documents from this phone to beam directly to your PC screen.
                                </Text>
                                <View style={styles.pcSendBtnRow}>
                                    <Button
                                        label="+ Photos / Video"
                                        icon="images-outline"
                                        variant="secondary"
                                        size="sm"
                                        loading={uploadingToPc}
                                        onPress={handleSendPhotosToPc}
                                    />
                                    <Button
                                        label="+ Documents"
                                        icon="document-text-outline"
                                        variant="secondary"
                                        size="sm"
                                        loading={uploadingToPc}
                                        onPress={handleSendDocumentToPc}
                                    />
                                </View>
                            </Card>
                        </View>
                    ) : (
                        <View style={styles.inputBlock}>
                            <Button
                                label="Scan Desktop QR Code"
                                icon="camera-outline"
                                variant="primary"
                                size="lg"
                                fullWidth
                                onPress={() => {
                                    haptic.tap();
                                    setShowScanner(true);
                                }}
                            />

                            <View style={styles.orDivider}>
                                <View style={styles.dividerLine} />
                                <Text style={styles.orText}>OR ENTER MANUALLY</Text>
                                <View style={styles.dividerLine} />
                            </View>

                            <TextField
                                label="PAIRING LINK OR CODE"
                                value={pairInput}
                                onChangeText={(t) => {
                                    setPairInput(t);
                                    setErrorMsg(null);
                                }}
                                placeholder="Paste pair URL or session UUID"
                                icon="link-outline"
                                autoCapitalize="none"
                                autoCorrect={false}
                                hint="On your desktop browser, click Pair or open /pair to view the QR code / link."
                            />

                            {errorMsg ? (
                                <View style={styles.errorWrap}>
                                    <Notice tone="danger" message={errorMsg} />
                                </View>
                            ) : null}

                            <Button
                                label="Connect & Receive Files"
                                icon="swap-horizontal-outline"
                                variant="secondary"
                                size="md"
                                fullWidth
                                disabled={pairInput.trim().length < 8}
                                loading={busy}
                                onPress={handleConnect}
                            />
                        </View>
                    )}
                </View>
            </View>

            <QRScannerModal
                visible={showScanner}
                onClose={() => setShowScanner(false)}
                onScan={(data) => {
                    setPairInput(data);
                    handleAutoConnect(data);
                }}
            />
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.75)',
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
        maxWidth: 300,
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
    inputBlock: {
        gap: space.md,
    },
    errorWrap: {
        marginVertical: space.xs,
    },
    readyBlock: {
        gap: space.md,
        paddingVertical: space.xs,
    },
    statusBadgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
    },
    actionCard: {
        gap: space.sm,
        padding: space.md,
        backgroundColor: colors.surfaceRaised,
    },
    actionCardTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
    },
    actionCardDesc: {
        color: colors.textMuted,
        fontSize: 12,
        lineHeight: 16,
    },
    pcSendBtnRow: {
        flexDirection: 'row',
        gap: space.sm,
        marginTop: 4,
    },
    orDivider: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        marginVertical: space.xs,
    },
    dividerLine: {
        flex: 1,
        height: 1,
        backgroundColor: colors.border,
    },
    orText: {
        color: colors.textMuted,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.8,
    },
});
