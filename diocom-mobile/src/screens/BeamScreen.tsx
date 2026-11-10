import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';

import { uploadDocument } from '../api/client';
import {
    loadSavedPeers,
    removeSavedPeer,
    type SavedPeer,
} from '../storage/savedPeers';
import { colors, formatRelativeTime, radius, space } from '../theme';
import {
    Badge,
    Button,
    Card,
    haptic,
    Icon,
    IconButton,
    type IconName,
    useToast,
} from '../ui';
import { UserPushModal } from './UserPushModal';

interface BeamScreenProps {
    serverUrl: string;
    signedIn: boolean;
    onOpenRadar: () => void;
    onOpenPair: () => void;
    onOpenLobby: () => void;
    onOpenAuth?: () => void;
}

export function BeamScreen({
    serverUrl,
    signedIn,
    onOpenRadar,
    onOpenPair,
    onOpenLobby,
    onOpenAuth,
}: BeamScreenProps) {
    const toast = useToast();
    const [savedPeers, setSavedPeers] = useState<SavedPeer[]>([]);
    const [pushTarget, setPushTarget] = useState<{
        shareId: string;
        filename: string;
    } | null>(null);
    const [uploadingForPush, setUploadingForPush] = useState(false);

    const refreshPeers = useCallback(async () => {
        try {
            const list = await loadSavedPeers();
            setSavedPeers(list);
        } catch {
            // Ignore storage load errors
        }
    }, []);

    useEffect(() => {
        refreshPeers();
    }, [refreshPeers]);

    const handleRemovePeer = async (peer: SavedPeer) => {
        haptic.medium();
        Alert.alert(
            'Forget Connection',
            `Remove "${peer.name}" from your saved connections?`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Remove',
                    style: 'destructive',
                    onPress: async () => {
                        const next = await removeSavedPeer(peer.id);
                        setSavedPeers(next);
                        toast.show(`Removed "${peer.name}"`);
                    },
                },
            ],
        );
    };

    const handleQuickResend = async (peer: SavedPeer) => {
        haptic.medium();
        if (peer.type === 'desktop') {
            // Re-open pair modal
            onOpenPair();
            return;
        }
        if (peer.type === 'radar') {
            // Re-open radar modal
            onOpenRadar();
            return;
        }
        if (peer.type === 'lobby') {
            onOpenLobby();
            return;
        }
        // User transfer: pick file and open UserPushModal
        await handleStartUserPush();
    };

    const handleStartUserPush = async () => {
        if (!signedIn && onOpenAuth) {
            haptic.warning();
            toast.show('Sign in to send files directly to another user handle.', 'info');
            onOpenAuth();
            return;
        }

        haptic.light();
        try {
            const res = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
            });

            if (res.canceled || !res.assets || !res.assets[0]) return;
            const asset = res.assets[0];

            setUploadingForPush(true);
            toast.show(`Preparing "${asset.name}" for delivery...`);

            const uploadRes = await uploadDocument({
                serverUrl,
                asset: {
                    ...asset,
                    lastModified: asset.lastModified ?? Date.now(),
                },
            });

            const shareId =
                uploadRes.link.split('/').pop() ||
                String(Date.now());

            setPushTarget({
                shareId,
                filename: asset.name,
            });
        } catch (err) {
            haptic.error();
            toast.show(
                `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
                'error',
            );
        } finally {
            setUploadingForPush(false);
        }
    };

    const getPeerIcon = (type: SavedPeer['type']): IconName => {
        switch (type) {
            case 'desktop':
                return 'desktop-outline';
            case 'mobile':
                return 'phone-portrait-outline';
            case 'user':
                return 'person-circle-outline';
            case 'radar':
                return 'radio-outline';
            default:
                return 'flash-outline';
        }
    };

    return (
        <View style={styles.container}>
            {/* SCREEN INTRO */}
            <View style={styles.headerBlock}>
                <Text style={styles.screenTitle}>Instant Beam</Text>
                <Text style={styles.screenSubtitle}>
                    Direct device-to-device file transfer without links or cloud delays.
                </Text>
            </View>

            {/* SAVED & RECENT CONNECTIONS SECTION */}
            <View style={styles.sectionWrap}>
                <View style={styles.sectionHeaderRow}>
                    <Text style={styles.sectionHeaderTitle}>SAVED & RECENT DEVICES</Text>
                    {savedPeers.length > 0 ? (
                        <Text style={styles.sectionHeaderCount}>{savedPeers.length} active</Text>
                    ) : null}
                </View>

                {savedPeers.length > 0 ? (
                    <ScrollView
                        horizontal
                        showsHorizontalScrollIndicator={false}
                        contentContainerStyle={styles.savedPeersScroll}
                    >
                        {savedPeers.map((peer) => (
                            <Card key={peer.id} style={styles.peerCard}>
                                <View style={styles.peerCardTop}>
                                    <View style={styles.peerIconWrap}>
                                        <Icon
                                            name={getPeerIcon(peer.type)}
                                            size={20}
                                            color={colors.primary}
                                        />
                                    </View>
                                    <IconButton
                                        icon="close"
                                        label="Forget connection"
                                        size={24}
                                        tint={colors.textFaint}
                                        onPress={() => handleRemovePeer(peer)}
                                    />
                                </View>

                                <View style={styles.peerInfoWrap}>
                                    <Text style={styles.peerName} numberOfLines={1}>
                                        {peer.name}
                                    </Text>
                                    <Text style={styles.peerMeta}>
                                        {formatRelativeTime(peer.lastTransferredAt)}
                                    </Text>
                                </View>

                                <Button
                                    label="Beam Again"
                                    icon="flash"
                                    size="sm"
                                    variant="primary"
                                    fullWidth
                                    onPress={() => handleQuickResend(peer)}
                                />
                            </Card>
                        ))}
                    </ScrollView>
                ) : (
                    <View style={styles.noPeersBox}>
                        <Icon name="link-outline" size={20} color={colors.textFaint} />
                        <Text style={styles.noPeersText}>
                            Recent connections, paired PCs, and @username contacts will appear here for 1-tap re-sending.
                        </Text>
                    </View>
                )}
            </View>

            {/* BEAM MODES LIST */}
            <View style={styles.cardsList}>
                {/* 1. RADAR LOCAL MESH */}
                <Card style={styles.modeCard}>
                    <View style={styles.modeCardHeader}>
                        <View style={[styles.modeIconWrap, { backgroundColor: colors.primarySoft }]}>
                            <Icon name="radio" size={26} color={colors.primary} />
                        </View>
                        <View style={styles.modeHeaderInfo}>
                            <View style={styles.badgeRow}>
                                <Badge label="AirDrop-style" tone="primary" icon="wifi" />
                                <Badge label="Zero-Internet" tone="neutral" />
                            </View>
                            <Text style={styles.modeTitle}>Radar Local Mesh</Text>
                        </View>
                    </View>
                    <Text style={styles.modeDescription}>
                        Automatically discover nearby phones, tablets, and computers on your Wi-Fi and beam files directly at maximum local network speed.
                    </Text>
                    <Button
                        label="Launch Radar"
                        icon="radio-outline"
                        variant="primary"
                        size="md"
                        fullWidth
                        onPress={() => {
                            haptic.medium();
                            onOpenRadar();
                        }}
                    />
                </Card>

                {/* 2. DESKTOP QR PAIR */}
                <Card style={styles.modeCard}>
                    <View style={styles.modeCardHeader}>
                        <View style={[styles.modeIconWrap, { backgroundColor: colors.successSoft }]}>
                            <Icon name="qr-code" size={26} color={colors.success} />
                        </View>
                        <View style={styles.modeHeaderInfo}>
                            <View style={styles.badgeRow}>
                                <Badge label="Instant Sync" tone="success" icon="sync" />
                                <Badge label="Phone ↔ PC" tone="neutral" />
                            </View>
                            <Text style={styles.modeTitle}>Pair with Computer</Text>
                        </View>
                    </View>
                    <Text style={styles.modeDescription}>
                        Scan the pairing QR code displayed on your desktop browser to instantly send photos, videos, and documents directly to your PC.
                    </Text>
                    <Button
                        label="Scan Desktop QR Code"
                        icon="scan-outline"
                        variant="tonal"
                        size="md"
                        fullWidth
                        onPress={() => {
                            haptic.medium();
                            onOpenPair();
                        }}
                    />
                </Card>

                {/* 3. SEND TO @USERNAME (ONLINE / OFFLINE) */}
                <Card style={styles.modeCard}>
                    <View style={styles.modeCardHeader}>
                        <View style={[styles.modeIconWrap, { backgroundColor: 'rgba(168, 85, 247, 0.15)' }]}>
                            <Icon name="person" size={26} color="#c084fc" />
                        </View>
                        <View style={styles.modeHeaderInfo}>
                            <View style={styles.badgeRow}>
                                <Badge label="Personal Vault" tone="primary" icon="shield-checkmark" />
                                <Badge label="Online or Offline" tone="neutral" />
                            </View>
                            <Text style={styles.modeTitle}>Send to @Username</Text>
                        </View>
                    </View>
                    <Text style={styles.modeDescription}>
                        Deposit files directly into another user&apos;s encrypted personal vault. They&apos;ll receive an instant transfer notification and can accept it anytime.
                    </Text>
                    <Button
                        label={uploadingForPush ? 'Uploading File...' : 'Send to @Username'}
                        icon="paper-plane"
                        variant="tonal"
                        size="md"
                        loading={uploadingForPush}
                        fullWidth
                        onPress={handleStartUserPush}
                    />
                </Card>

                {/* 4. GROUP LOBBY */}
                <Card style={styles.modeCard}>
                    <View style={styles.modeCardHeader}>
                        <View style={[styles.modeIconWrap, { backgroundColor: colors.warningSoft }]}>
                            <Icon name="people" size={26} color={colors.warning} />
                        </View>
                        <View style={styles.modeHeaderInfo}>
                            <View style={styles.badgeRow}>
                                <Badge label="Meeting Code" tone="warning" icon="flash" />
                                <Badge label="Multi-User" tone="neutral" />
                            </View>
                            <Text style={styles.modeTitle}>Group Lobby Room</Text>
                        </View>
                    </View>
                    <Text style={styles.modeDescription}>
                        Distribute files to a room of people simultaneously. Host a room or enter a temporary 4-digit code to join an ongoing session.
                    </Text>
                    <Button
                        label="Join or Create Room"
                        icon="people-outline"
                        variant="tonal"
                        size="md"
                        fullWidth
                        onPress={() => {
                            haptic.medium();
                            onOpenLobby();
                        }}
                    />
                </Card>
            </View>

            {/* EMBEDDED USER PUSH MODAL */}
            {pushTarget ? (
                <UserPushModal
                    visible={true}
                    serverUrl={serverUrl}
                    shareId={pushTarget.shareId}
                    filename={pushTarget.filename}
                    onClose={() => setPushTarget(null)}
                    onSuccess={() => {
                        setPushTarget(null);
                        refreshPeers();
                    }}
                />
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        gap: space.lg,
    },
    headerBlock: {
        gap: space.xs,
        paddingHorizontal: space.xs,
    },
    screenTitle: {
        color: colors.text,
        fontSize: 22,
        fontWeight: '800',
        letterSpacing: -0.3,
    },
    screenSubtitle: {
        color: colors.textMuted,
        fontSize: 13,
        lineHeight: 18,
    },
    sectionWrap: {
        gap: space.sm,
    },
    sectionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: space.xs,
    },
    sectionHeaderTitle: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '800',
        letterSpacing: 0.8,
    },
    sectionHeaderCount: {
        color: colors.primary,
        fontSize: 11,
        fontWeight: '700',
    },
    savedPeersScroll: {
        gap: space.md,
        paddingHorizontal: space.xs,
        paddingVertical: 2,
    },
    peerCard: {
        width: 156,
        padding: space.md,
        gap: space.sm,
        backgroundColor: colors.surfaceRaised,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: radius.lg,
    },
    peerCardTop: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    peerIconWrap: {
        width: 34,
        height: 34,
        borderRadius: 17,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    peerInfoWrap: {
        gap: 2,
    },
    peerName: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
    },
    peerMeta: {
        color: colors.textFaint,
        fontSize: 11,
    },
    noPeersBox: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        padding: space.md,
        borderRadius: radius.lg,
        backgroundColor: 'rgba(255,255,255,0.02)',
        borderWidth: 1,
        borderStyle: 'dashed',
        borderColor: 'rgba(255,255,255,0.08)',
    },
    noPeersText: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 16,
        flex: 1,
    },
    cardsList: {
        gap: space.md,
    },
    modeCard: {
        gap: space.md,
        padding: space.lg,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.xl,
    },
    modeCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
    },
    modeIconWrap: {
        width: 52,
        height: 52,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modeHeaderInfo: {
        flex: 1,
        gap: 4,
    },
    badgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
    },
    modeTitle: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '700',
    },
    modeDescription: {
        color: colors.textMuted,
        fontSize: 13,
        lineHeight: 19,
    },
});
