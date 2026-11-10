import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space } from '../theme';
import { Badge, haptic, Icon, type IconName, IconButton, RadarPulse } from '../ui';

interface BeamHubModalProps {
    visible: boolean;
    signedIn: boolean;
    onClose: () => void;
    onOpenRadar: () => void;
    onOpenPair: () => void;
    onOpenLobby: () => void;
    onOpenSpaces: () => void;
    onOpenUpload: () => void;
    onOpenAuth: () => void;
}

interface HubOption {
    id: string;
    title: string;
    subtitle: string;
    icon: IconName;
    badge?: string;
    iconColor: string;
    bgColor: string;
    requiresAuth?: boolean;
    onPress: () => void;
}

export function BeamHubModal({
    visible,
    signedIn,
    onClose,
    onOpenRadar,
    onOpenPair,
    onOpenLobby,
    onOpenSpaces,
    onOpenUpload,
    onOpenAuth,
}: BeamHubModalProps) {
    const options: HubOption[] = [
        {
            id: 'radar',
            title: 'AirDrop Local Radar',
            subtitle: 'Zero-internet local discovery & gigabit direct beaming',
            icon: 'radio',
            badge: 'AirDrop P2P',
            iconColor: colors.primary,
            bgColor: colors.primarySoft,
            onPress: () => {
                onClose();
                onOpenRadar();
            },
        },
        {
            id: 'pair',
            title: 'Desktop QR Pair',
            subtitle: 'Beam files between phone and PC without typing URLs',
            icon: 'qr-code-outline',
            badge: 'P2P Sync',
            iconColor: colors.primary,
            bgColor: colors.primarySoft,
            onPress: () => {
                onClose();
                onOpenPair();
            },
        },
        {
            id: 'lobby',
            title: 'Live Lobby Room',
            subtitle: 'Temporary in-person file drop via 6-digit room code',
            icon: 'flash',
            badge: 'Instant LAN',
            iconColor: colors.primary,
            bgColor: colors.primarySoft,
            onPress: () => {
                onClose();
                onOpenLobby();
            },
        },
        {
            id: 'spaces',
            title: 'Shared Spaces',
            subtitle: 'Collaborative team folders with custom permission tiers',
            icon: 'folder-open',
            badge: 'Persistent',
            iconColor: colors.violet,
            bgColor: colors.violetSoft,
            requiresAuth: true,
            onPress: () => {
                onClose();
                if (signedIn) {
                    onOpenSpaces();
                } else {
                    onOpenAuth();
                }
            },
        },
        {
            id: 'link',
            title: 'Encrypted Link',
            subtitle: 'Expiring, password-protected zero-knowledge download URL',
            icon: 'link-outline',
            badge: 'Zero-Knowledge',
            iconColor: colors.success,
            bgColor: colors.successSoft,
            onPress: () => {
                onClose();
                onOpenUpload();
            },
        },
    ];

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            <View style={styles.backdrop}>
                <View style={styles.container}>
                    {/* MODAL HEADER */}
                    <View style={styles.header}>
                        <View style={styles.headerTitleRow}>
                            <View style={styles.hubIconWrap}>
                                <Icon name="flash" size={18} color={colors.primary} />
                            </View>
                            <View>
                                <Text style={styles.title}>Datran Beam Hub</Text>
                                <Text style={styles.subtitle}>Fast, direct device-to-device transfers</Text>
                            </View>
                        </View>
                        <IconButton icon="close" label="Close hub" size={36} onPress={onClose} />
                    </View>

                    <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
                        {/* RADAR PULSE HERO */}
                        <RadarPulse
                            size={100}
                            icon="wifi"
                            statusText="Zero-Internet LAN Discovery Ready"
                            subText="Beams at gigabit speeds over local Wi-Fi & Hotspots"
                        />

                        {/* TRANSFER MODES LIST */}
                        <View style={styles.optionsList}>
                            {options.map((opt) => (
                                <Pressable
                                    key={opt.id}
                                    onPress={() => {
                                        haptic.medium();
                                        opt.onPress();
                                    }}
                                    style={({ pressed }) => [
                                        styles.optionCard,
                                        pressed && styles.optionCardPressed,
                                    ]}
                                >
                                    <View style={[styles.optionIconBox, { backgroundColor: opt.bgColor }]}>
                                        <Icon name={opt.icon} size={22} color={opt.iconColor} />
                                    </View>

                                    <View style={styles.optionContent}>
                                        <View style={styles.optionTitleRow}>
                                            <Text style={styles.optionTitle}>{opt.title}</Text>
                                            {opt.badge ? (
                                                <Badge label={opt.badge} tone="neutral" />
                                            ) : null}
                                        </View>
                                        <Text style={styles.optionSubtitle}>{opt.subtitle}</Text>
                                        {opt.requiresAuth && !signedIn ? (
                                            <Text style={styles.authHint}>Requires account sign in</Text>
                                        ) : null}
                                    </View>

                                    <Icon name="chevron-forward" size={18} color={colors.textFaint} />
                                </Pressable>
                            ))}
                        </View>
                    </ScrollView>
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
    container: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        maxHeight: '88%',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.md,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: colors.border,
    },
    headerTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    hubIconWrap: {
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
    body: {
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        gap: space.lg,
    },
    optionsList: {
        gap: space.md,
    },
    optionCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 14,
        padding: space.md,
        borderRadius: radius.xl,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.border,
    },
    optionCardPressed: {
        backgroundColor: colors.surfacePressed,
        borderColor: colors.primaryBorder,
        transform: [{ scale: 0.99 }],
    },
    optionIconBox: {
        width: 46,
        height: 46,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
    },
    optionContent: {
        flex: 1,
        gap: 3,
    },
    optionTitleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    optionTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    optionSubtitle: {
        color: colors.textMuted,
        fontSize: 12,
        lineHeight: 16,
    },
    authHint: {
        color: colors.warning,
        fontSize: 11,
        fontWeight: '600',
        marginTop: 2,
    },
});
