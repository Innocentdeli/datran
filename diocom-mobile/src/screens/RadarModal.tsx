import React, { useEffect, useRef, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Animated,
    Dimensions,
    Easing,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { uploadDocument } from '../api/client';
import { recordPeerTransfer } from '../storage/savedPeers';
import {
    announceToRadar,
    pollRadarInbox,
    respondToBeam,
    sendBeamToPeers,
    type IncomingBeam,
    type RadarPeer,
} from '../services/radarDiscovery';
import { colors, formatBytes, radius, space } from '../theme';
import { Badge, Button, Card, haptic, Icon, IconButton, useToast } from '../ui';

interface RadarModalProps {
    visible: boolean;
    serverUrl: string;
    onClose: () => void;
    onFilesReceived?: (links: string[]) => void;
}

export function RadarModal({ visible, serverUrl, onClose, onFilesReceived }: RadarModalProps) {
    const toast = useToast();
    const [peers, setPeers] = useState<RadarPeer[]>([]);
    const [selectedPeerIds, setSelectedPeerIds] = useState<string[]>([]);
    const [incomingBeam, setIncomingBeam] = useState<IncomingBeam | null>(null);
    const [beaming, setBeaming] = useState(false);
    const [beamingTargetCount, setBeamingTargetCount] = useState<number>(0);
    const [progressPercent, setProgressPercent] = useState<number | null>(null);

    // Animation values
    const spinAnim = useRef(new Animated.Value(0)).current;
    const pulseAnim = useRef(new Animated.Value(1)).current;

    useEffect(() => {
        if (!visible) return;

        // Radar rotation animation
        const spin = Animated.loop(
            Animated.timing(spinAnim, {
                toValue: 1,
                duration: 4500,
                easing: Easing.linear,
                useNativeDriver: true,
            })
        );
        spin.start();

        // Heartbeat pulse animation
        const pulse = Animated.loop(
            Animated.sequence([
                Animated.timing(pulseAnim, {
                    toValue: 1.08,
                    duration: 1200,
                    easing: Easing.out(Easing.ease),
                    useNativeDriver: true,
                }),
                Animated.timing(pulseAnim, {
                    toValue: 1,
                    duration: 1200,
                    easing: Easing.in(Easing.ease),
                    useNativeDriver: true,
                }),
            ])
        );
        pulse.start();

        return () => {
            spin.stop();
            pulse.stop();
        };
    }, [visible, spinAnim, pulseAnim]);

    // Announce & Inbox Polling
    useEffect(() => {
        if (!visible || !serverUrl) return;

        let active = true;

        const syncLoop = async () => {
            try {
                const livePeers = await announceToRadar(serverUrl);
                if (active) {
                    setPeers(livePeers);
                    // Prune selected IDs that are no longer active
                    setSelectedPeerIds((prev) => prev.filter((id) => livePeers.some((p) => p.id === id)));
                }

                const beams = await pollRadarInbox(serverUrl);
                if (active && beams.length > 0) {
                    setIncomingBeam(beams[0] ?? null);
                    haptic.warning();
                }
            } catch {
                // Ignore transient network errors
            }
        };

        syncLoop();
        const interval = setInterval(syncLoop, 3000);

        return () => {
            active = false;
            clearInterval(interval);
        };
    }, [visible, serverUrl]);

    const handleTogglePeer = (peer: RadarPeer) => {
        haptic.tap();
        setSelectedPeerIds((prev) => {
            if (prev.includes(peer.id)) {
                return prev.filter((id) => id !== peer.id);
            } else {
                return [...prev, peer.id];
            }
        });
    };

    const handleSelectAll = () => {
        haptic.tap();
        if (selectedPeerIds.length === peers.length) {
            setSelectedPeerIds([]);
        } else {
            setSelectedPeerIds(peers.map((p) => p.id));
        }
    };

    const promptPickForPeers = (targets: RadarPeer[]) => {
        if (targets.length === 0) return;
        haptic.medium();

        const isMulti = targets.length > 1;
        const title = isMulti
            ? `Beam to ${targets.length} Devices`
            : `Beam to ${targets[0]?.name || 'Nearby Device'}`;
        const message = isMulti
            ? `Broadcasting simultaneously to: ${targets.map((t) => t.name).join(', ')}`
            : 'Choose the file type you would like to beam instantly over LAN';

        Alert.alert(title, message, [
            { text: 'Cancel', style: 'cancel' },
            {
                text: 'Photo or Video',
                onPress: () => handlePickMedia(targets),
            },
            {
                text: 'Document / File',
                onPress: () => handlePickDocument(targets),
            },
        ]);
    };

    const handlePickMedia = async (targets: RadarPeer[]) => {
        try {
            const res = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images', 'videos'],
                quality: 1,
            });

            if (res.canceled || !res.assets[0]) return;
            const item = res.assets[0];
            await dispatchBeam(targets, {
                uri: item.uri,
                name: item.fileName || `media_${Date.now()}.${item.uri.split('.').pop() || 'jpg'}`,
                size: item.fileSize,
                mimeType: item.mimeType,
            });
        } catch (err) {
            toast.show(`Could not select media: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
    };

    const handlePickDocument = async (targets: RadarPeer[]) => {
        try {
            const res = await DocumentPicker.getDocumentAsync({
                copyToCacheDirectory: true,
            });

            if (res.canceled || !res.assets[0]) return;
            const doc = res.assets[0];
            await dispatchBeam(targets, {
                uri: doc.uri,
                name: doc.name,
                size: doc.size,
                mimeType: doc.mimeType,
            });
        } catch (err) {
            toast.show(`Could not select file: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
    };

    const dispatchBeam = async (
        targets: RadarPeer[],
        asset: { uri: string; name: string; size?: number; mimeType?: string }
    ) => {
        if (targets.length === 0) return;
        setBeaming(true);
        setBeamingTargetCount(targets.length);
        setProgressPercent(0);
        haptic.light();

        try {
            const docAsset: DocumentPicker.DocumentPickerAsset = {
                uri: asset.uri,
                name: asset.name,
                size: asset.size,
                mimeType: asset.mimeType,
                lastModified: Date.now(),
            };

            const result = await uploadDocument({
                serverUrl,
                asset: docAsset,
                onProgress: (p) => {
                    const pct = Math.round((p.bytesSent / p.totalBytes) * 100);
                    setProgressPercent(pct);
                },
            });

            const fileId = result.link.split('/').pop() || '';
            const targetIds = targets.map((p) => p.id);
            const ok = await sendBeamToPeers(serverUrl, targetIds, [fileId], asset.name, asset.size);

            if (ok) {
                for (const peer of targets) {
                    await recordPeerTransfer({
                        id: peer.id,
                        name: peer.name,
                        type: (peer.type as any) || 'radar',
                        platform: peer.platform,
                        serverUrl,
                    });
                }
                haptic.success();
                if (targets.length === 1) {
                    toast.show(`Successfully beamed "${asset.name}" to ${targets[0]?.name || 'device'}!`);
                } else {
                    toast.show(`Successfully beamed "${asset.name}" to ${targets.length} devices!`);
                }
                setSelectedPeerIds([]);
            } else {
                throw new Error('Failed to notify peers');
            }
        } catch (err) {
            haptic.error();
            toast.show(`Beam failed: ${err instanceof Error ? err.message : String(err)}`, 'error');
        } finally {
            setBeaming(false);
            setProgressPercent(null);
            setBeamingTargetCount(0);
        }
    };

    const handleAcceptIncoming = async () => {
        if (!incomingBeam) return;
        haptic.success();

        try {
            await respondToBeam(serverUrl, incomingBeam.id, true);
            const cleanUrl = serverUrl.replace(/\/+$/, '');
            const links = incomingBeam.fileIds.map((id) => `${cleanUrl}/v1/${id}`);

            await recordPeerTransfer({
                id: incomingBeam.fromPeerId || incomingBeam.fromName,
                name: incomingBeam.fromName,
                type: 'radar',
                serverUrl,
            });

            onFilesReceived?.(links);
            toast.show(`Received "${incomingBeam.fileName || 'file'}" from ${incomingBeam.fromName}!`);
        } catch (err) {
            toast.show(`Error receiving beam: ${err instanceof Error ? err.message : String(err)}`, 'error');
        } finally {
            setIncomingBeam(null);
        }
    };

    const handleDeclineIncoming = async () => {
        if (!incomingBeam) return;
        haptic.tap();
        try {
            await respondToBeam(serverUrl, incomingBeam.id, false);
        } catch {}
        setIncomingBeam(null);
    };

    const spinInterpolate = spinAnim.interpolate({
        inputRange: [0, 1],
        outputRange: ['0deg', '360deg'],
    });

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            <View style={styles.backdrop}>
                <View style={styles.sheet}>
                    {/* HEADER */}
                    <View style={styles.header}>
                        <View style={styles.headerTitleRow}>
                            <View style={styles.radarIconBox}>
                                <Icon name="radio" size={20} color={colors.primary} />
                            </View>
                            <View>
                                <Text style={styles.title}>AirDrop Local Radar</Text>
                                <Text style={styles.subtitle}>Zero-Internet Local Subnet Discovery</Text>
                            </View>
                        </View>
                        <IconButton icon="close" label="Close radar" size={36} onPress={onClose} />
                    </View>

                    {/* INCOMING BEAM CARD (FLOATING NOTIFICATION) */}
                    {incomingBeam ? (
                        <View style={styles.incomingCard}>
                            <View style={styles.incomingHeader}>
                                <View style={styles.incomingIconWrap}>
                                    <Icon name="flash" size={18} color={colors.primary} />
                                </View>
                                <View style={{ flex: 1 }}>
                                    <Text style={styles.incomingTitle}>Incoming Direct Beam!</Text>
                                    <Text style={styles.incomingSubtitle}>from {incomingBeam.fromName}</Text>
                                </View>
                            </View>

                            <View style={styles.incomingFileInfo}>
                                <Text style={styles.incomingFileName} numberOfLines={1}>
                                    {incomingBeam.fileName || 'Shared Document'}
                                </Text>
                                {incomingBeam.fileSize ? (
                                    <Text style={styles.incomingFileSize}>
                                        {formatBytes(incomingBeam.fileSize)} • Gigabit Direct Transfer
                                    </Text>
                                ) : null}
                            </View>

                            <View style={styles.incomingActions}>
                                <Button
                                    label="Decline"
                                    variant="secondary"
                                    size="sm"
                                    onPress={handleDeclineIncoming}
                                />
                                <Button
                                    label="Accept & Save"
                                    icon="download-outline"
                                    variant="primary"
                                    size="sm"
                                    onPress={handleAcceptIncoming}
                                />
                            </View>
                        </View>
                    ) : null}

                    {/* BEAMING IN PROGRESS OVERLAY */}
                    {beaming ? (
                        <View style={styles.beamingCard}>
                            <ActivityIndicator size="small" color={colors.primary} />
                            <Text style={styles.beamingText}>
                                Beaming to {beamingTargetCount > 1 ? `${beamingTargetCount} devices` : 'device'}...{' '}
                                {progressPercent !== null ? `${progressPercent}%` : ''}
                            </Text>
                        </View>
                    ) : null}

                    {/* DISCOVERY & MULTI-SELECT TOOLBAR */}
                    {peers.length > 0 ? (
                        <View style={styles.toolbarRow}>
                            <View style={styles.statusRow}>
                                <View style={styles.pulseDot} />
                                <Text style={styles.toolbarCount}>
                                    {peers.length} active device{peers.length > 1 ? 's' : ''} nearby
                                </Text>
                            </View>
                            <Pressable onPress={handleSelectAll} style={styles.selectAllBtn} hitSlop={8}>
                                <Text style={styles.selectAllText}>
                                    {selectedPeerIds.length === peers.length
                                        ? 'Deselect All'
                                        : peers.length > 1 && selectedPeerIds.length > 0
                                        ? `Select All (${peers.length})`
                                        : 'Select All'}
                                </Text>
                            </Pressable>
                        </View>
                    ) : null}

                    {/* RADAR CANVAS */}
                    <View style={styles.radarCenter}>
                        {/* Concentric rings */}
                        <View style={[styles.ring, styles.ringOuter]} />
                        <View style={[styles.ring, styles.ringMiddle]} />
                        <View style={[styles.ring, styles.ringInner]} />

                        {/* Rotating scanner hand */}
                        <Animated.View
                            style={[
                                styles.sweepHand,
                                {
                                    transform: [{ rotate: spinInterpolate }],
                                },
                            ]}
                        />

                        {/* Central Device: This Phone */}
                        <Animated.View
                            style={[
                                styles.centerDevice,
                                {
                                    transform: [{ scale: pulseAnim }],
                                },
                            ]}
                        >
                            <Icon name="phone-portrait-outline" size={26} color={colors.primary} />
                            <Text style={styles.centerDeviceLabel}>This Phone</Text>
                            <Text style={styles.centerDeviceSub}>Broadcasting</Text>
                        </Animated.View>

                        {/* Discovered Orbiting Peers */}
                        {peers.map((peer, idx) => {
                            const count = peers.length;
                            const angle = (idx / count) * 2 * Math.PI - Math.PI / 2;
                            const radiusDist = 115;
                            const x = Math.cos(angle) * radiusDist;
                            const y = Math.sin(angle) * radiusDist;

                            const isDesktop = peer.type === 'desktop';
                            const isTablet = peer.type === 'tablet';
                            const isSelected = selectedPeerIds.includes(peer.id);

                            return (
                                <Pressable
                                    key={peer.id}
                                    onPress={() => handleTogglePeer(peer)}
                                    style={[
                                        styles.peerBubble,
                                        isSelected && styles.peerBubbleSelected,
                                        {
                                            transform: [{ translateX: x }, { translateY: y }],
                                        },
                                    ]}
                                >
                                    {isSelected ? (
                                        <View style={styles.checkBadge}>
                                            <Icon name="checkmark" size={12} color="#000" />
                                        </View>
                                    ) : null}
                                    <View style={styles.peerIconWrap}>
                                        <Icon
                                            name={
                                                isDesktop
                                                    ? 'laptop-outline'
                                                    : isTablet
                                                    ? 'tablet-portrait-outline'
                                                    : 'phone-portrait-outline'
                                            }
                                            size={20}
                                            color={isSelected ? colors.primary : colors.text}
                                        />
                                    </View>
                                    <Text
                                        style={[styles.peerName, isSelected && styles.peerNameSelected]}
                                        numberOfLines={1}
                                    >
                                        {peer.name}
                                    </Text>
                                    <Text style={[styles.peerTag, isSelected && styles.peerTagSelected]}>
                                        {isSelected ? 'SELECTED' : 'DIRECT LAN'}
                                    </Text>
                                </Pressable>
                            );
                        })}
                    </View>

                    {/* MULTI-BEAM ACTION BUTTONS */}
                    {peers.length > 0 ? (
                        <View style={styles.actionShelf}>
                            {selectedPeerIds.length > 0 ? (
                                <Button
                                    label={`Beam to ${
                                        selectedPeerIds.length === 1
                                            ? (peers.find((p) => p.id === selectedPeerIds[0])?.name || '1 Device')
                                            : `${selectedPeerIds.length} Devices`
                                    }`}
                                    icon="flash"
                                    variant="primary"
                                    size="md"
                                    disabled={beaming}
                                    onPress={() => {
                                        const targets = peers.filter((p) => selectedPeerIds.includes(p.id));
                                        promptPickForPeers(targets);
                                    }}
                                />
                            ) : (
                                <Button
                                    label={
                                        peers.length === 1
                                            ? `⚡ Beam to ${peers[0]?.name || 'Device'}`
                                            : `⚡ Beam to All Nearby (${peers.length} Devices)`
                                    }
                                    icon="flash"
                                    variant="primary"
                                    size="md"
                                    disabled={beaming}
                                    onPress={() => {
                                        setSelectedPeerIds(peers.map((p) => p.id));
                                        promptPickForPeers(peers);
                                    }}
                                />
                            )}
                        </View>
                    ) : null}

                    {/* STATUS FOOTER */}
                    <View style={styles.footer}>
                        <View style={styles.statusRow}>
                            <View style={styles.pulseDot} />
                            <Text style={styles.footerText}>
                                {peers.length === 0
                                    ? 'Listening for nearby laptops and phones on this network...'
                                    : `${peers.length} active device${peers.length > 1 ? 's' : ''} ready for direct gigabit beam`}
                            </Text>
                        </View>
                        <Text style={styles.footerHint}>
                            Tap device bubbles to multi-select, or beam to all at once
                        </Text>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.85)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xxl,
        maxHeight: '92%',
        gap: space.md,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingBottom: space.sm,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: colors.border,
    },
    headerTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    radarIconBox: {
        width: 38,
        height: 38,
        borderRadius: 12,
        backgroundColor: colors.primarySoft,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
    },
    title: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '800',
        letterSpacing: 0.3,
    },
    subtitle: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 2,
    },
    incomingCard: {
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        padding: space.md,
        gap: space.sm,
    },
    incomingHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    incomingIconWrap: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    incomingTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
    },
    incomingSubtitle: {
        color: colors.textMuted,
        fontSize: 11,
    },
    incomingFileInfo: {
        backgroundColor: colors.surface,
        borderRadius: radius.md,
        padding: space.sm,
    },
    incomingFileName: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    incomingFileSize: {
        color: colors.textMuted,
        fontSize: 11,
        marginTop: 2,
    },
    incomingActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: space.sm,
    },
    beamingCard: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
        padding: space.sm,
        borderRadius: radius.lg,
        backgroundColor: colors.primarySoft,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    beamingText: {
        color: colors.primary,
        fontSize: 12,
        fontWeight: '700',
    },
    radarCenter: {
        height: 300,
        alignItems: 'center',
        justifyContent: 'center',
        marginVertical: space.sm,
        position: 'relative',
    },
    ring: {
        position: 'absolute',
        borderRadius: 999,
        borderWidth: 1,
    },
    ringOuter: {
        width: 290,
        height: 290,
        borderColor: 'rgba(0,242,255,0.12)',
    },
    ringMiddle: {
        width: 200,
        height: 200,
        borderColor: 'rgba(0,242,255,0.20)',
    },
    ringInner: {
        width: 120,
        height: 120,
        borderColor: 'rgba(0,242,255,0.28)',
    },
    sweepHand: {
        position: 'absolute',
        width: 290,
        height: 290,
        borderRadius: 145,
        borderRightWidth: 2,
        borderColor: colors.primary,
        opacity: 0.4,
    },
    centerDevice: {
        width: 84,
        height: 84,
        borderRadius: 42,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 2,
        borderColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 16,
        elevation: 8,
        zIndex: 10,
    },
    centerDeviceLabel: {
        color: colors.text,
        fontSize: 10,
        fontWeight: '800',
        marginTop: 2,
    },
    centerDeviceSub: {
        color: colors.primary,
        fontSize: 8,
        fontWeight: '700',
        letterSpacing: 0.5,
        textTransform: 'uppercase',
    },
    peerBubble: {
        position: 'absolute',
        width: 74,
        height: 74,
        borderRadius: 37,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1.5,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 20,
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 8,
        elevation: 5,
        padding: 4,
    },
    peerIconWrap: {
        marginBottom: 2,
    },
    peerName: {
        color: colors.text,
        fontSize: 9,
        fontWeight: '700',
        textAlign: 'center',
        maxWidth: 64,
    },
    peerTag: {
        color: colors.primary,
        fontSize: 7,
        fontWeight: '800',
        letterSpacing: 0.4,
    },
    toolbarRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: space.xs,
        paddingBottom: space.xs,
    },
    toolbarCount: {
        color: colors.textMuted,
        fontSize: 12,
        fontWeight: '600',
    },
    selectAllBtn: {
        paddingHorizontal: space.sm,
        paddingVertical: 4,
        borderRadius: radius.md,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
    },
    selectAllText: {
        color: colors.primary,
        fontSize: 11,
        fontWeight: '700',
    },
    actionShelf: {
        gap: space.xs,
        marginVertical: space.xs,
    },
    checkBadge: {
        position: 'absolute',
        top: -4,
        right: -4,
        width: 20,
        height: 20,
        borderRadius: 10,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: colors.surface,
        zIndex: 30,
    },
    peerBubbleSelected: {
        backgroundColor: colors.primarySoft,
        borderColor: colors.primary,
        borderWidth: 2,
        shadowColor: colors.primary,
        shadowOpacity: 0.6,
        shadowRadius: 10,
    },
    peerNameSelected: {
        color: colors.text,
        fontWeight: '800',
    },
    peerTagSelected: {
        color: colors.primary,
        fontWeight: '900',
    },
    footer: {
        alignItems: 'center',
        gap: 4,
        paddingTop: space.xs,
    },
    statusRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    pulseDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.success,
    },
    footerText: {
        color: colors.textMuted,
        fontSize: 12,
        fontWeight: '600',
    },
    footerHint: {
        color: colors.textFaint,
        fontSize: 11,
        textAlign: 'center',
    },
});
