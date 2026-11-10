import { useEffect, useRef, useState } from 'react';
import {
    Animated,
    Modal,
    Pressable,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { colors, radius, space } from '../theme';
import { Button, haptic, Icon, IconButton } from '../ui';

interface QRScannerModalProps {
    visible: boolean;
    onClose: () => void;
    onScan: (scannedText: string) => void;
}

export function QRScannerModal({ visible, onClose, onScan }: QRScannerModalProps) {
    const [permission, requestPermission] = useCameraPermissions();
    const [torch, setTorch] = useState(false);
    const [scanned, setScanned] = useState(false);

    // Laser scan line animation
    const scanAnim = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (!visible) {
            setScanned(false);
            return;
        }

        const animation = Animated.loop(
            Animated.sequence([
                Animated.timing(scanAnim, {
                    toValue: 1,
                    duration: 2000,
                    useNativeDriver: true,
                }),
                Animated.timing(scanAnim, {
                    toValue: 0,
                    duration: 2000,
                    useNativeDriver: true,
                }),
            ])
        );

        animation.start();
        return () => animation.stop();
    }, [visible, scanAnim]);

    const handleBarcodeScanned = ({ data }: { data: string }) => {
        if (scanned || !data) return;
        setScanned(true);
        haptic.success();
        onScan(data);
        onClose();
    };

    return (
        <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
            <View style={styles.container}>
                {!permission ? (
                    <View style={styles.permissionBox}>
                        <Text style={styles.permText}>Requesting camera permission...</Text>
                    </View>
                ) : !permission.granted ? (
                    <View style={styles.permissionBox}>
                        <View style={styles.permIcon}>
                            <Icon name="camera" size={36} color={colors.primary} />
                        </View>
                        <Text style={styles.permTitle}>Camera Access Required</Text>
                        <Text style={styles.permSub}>
                            Datran needs camera access to scan desktop and mobile pairing QR codes.
                        </Text>
                        <Button
                            label="Grant Camera Permission"
                            icon="shield-checkmark-outline"
                            variant="primary"
                            size="md"
                            onPress={requestPermission}
                        />
                        <Button
                            label="Cancel"
                            variant="ghost"
                            size="sm"
                            onPress={onClose}
                        />
                    </View>
                ) : (
                    <View style={StyleSheet.absoluteFill}>
                        {/* Live Camera View */}
                        <CameraView
                            style={StyleSheet.absoluteFill}
                            enableTorch={torch}
                            barcodeScannerSettings={{
                                barcodeTypes: ['qr'],
                            }}
                            onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
                        />

                        {/* Darkened Mask Overlays */}
                        <View style={styles.topMask}>
                            <View style={styles.topBar}>
                                <Text style={styles.topTitle}>Scan Pairing Code</Text>
                                <IconButton
                                    icon={torch ? 'flash' : 'flash-off'}
                                    label="Toggle Flashlight"
                                    size={40}
                                    tint={torch ? colors.primary : colors.textMuted}
                                    onPress={() => {
                                        haptic.tap();
                                        setTorch(!torch);
                                    }}
                                />
                                <IconButton
                                    icon="close"
                                    label="Close Scanner"
                                    size={40}
                                    onPress={onClose}
                                />
                            </View>
                        </View>

                        {/* Scanner Target Center Box */}
                        <View style={styles.centerRow}>
                            <View style={styles.sideMask} />
                            <View style={styles.reticle}>
                                {/* Corner Brackets */}
                                <View style={[styles.corner, styles.topLeft]} />
                                <View style={[styles.corner, styles.topRight]} />
                                <View style={[styles.corner, styles.bottomLeft]} />
                                <View style={[styles.corner, styles.bottomRight]} />

                                {/* Moving Laser Line */}
                                <Animated.View
                                    style={[
                                        styles.laser,
                                        {
                                            transform: [
                                                {
                                                    translateY: scanAnim.interpolate({
                                                        inputRange: [0, 1],
                                                        outputRange: [0, 240],
                                                    }),
                                                },
                                            ],
                                        },
                                    ]}
                                />
                            </View>
                            <View style={styles.sideMask} />
                        </View>

                        {/* Bottom Instruction Mask */}
                        <View style={styles.bottomMask}>
                            <Text style={styles.instructionText}>
                                Point your camera at the QR code on your computer or another phone
                            </Text>
                            <View style={styles.badgeRow}>
                                <View style={styles.badgeDot} />
                                <Text style={styles.badgeText}>Instant Auto-Pairing Active</Text>
                            </View>
                        </View>
                    </View>
                )}
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#000',
    },
    permissionBox: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.xxl,
        gap: space.md,
        backgroundColor: colors.surface,
    },
    permIcon: {
        width: 72,
        height: 72,
        borderRadius: 36,
        backgroundColor: colors.primarySoft,
        borderWidth: 1.5,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
    },
    permTitle: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '800',
    },
    permSub: {
        color: colors.textMuted,
        fontSize: 13,
        textAlign: 'center',
        lineHeight: 18,
    },
    permText: {
        color: colors.textMuted,
        fontSize: 14,
    },
    topMask: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.65)',
        paddingTop: 54,
        paddingHorizontal: space.lg,
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    topTitle: {
        color: '#fff',
        fontSize: 16,
        fontWeight: '700',
        letterSpacing: 0.3,
        flex: 1,
    },
    centerRow: {
        flexDirection: 'row',
        height: 250,
    },
    sideMask: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.65)',
    },
    reticle: {
        width: 250,
        height: 250,
        position: 'relative',
        backgroundColor: 'transparent',
    },
    corner: {
        position: 'absolute',
        width: 28,
        height: 28,
        borderColor: colors.primary,
    },
    topLeft: {
        top: 0,
        left: 0,
        borderTopWidth: 3.5,
        borderLeftWidth: 3.5,
        borderTopLeftRadius: 10,
    },
    topRight: {
        top: 0,
        right: 0,
        borderTopWidth: 3.5,
        borderRightWidth: 3.5,
        borderTopRightRadius: 10,
    },
    bottomLeft: {
        bottom: 0,
        left: 0,
        borderBottomWidth: 3.5,
        borderLeftWidth: 3.5,
        borderBottomLeftRadius: 10,
    },
    bottomRight: {
        bottom: 0,
        right: 0,
        borderBottomWidth: 3.5,
        borderRightWidth: 3.5,
        borderBottomRightRadius: 10,
    },
    laser: {
        height: 2,
        width: '100%',
        backgroundColor: colors.primary,
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.9,
        shadowRadius: 8,
        elevation: 6,
    },
    bottomMask: {
        flex: 1.4,
        backgroundColor: 'rgba(0,0,0,0.65)',
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: space.xxl,
        gap: space.md,
    },
    instructionText: {
        color: colors.textMuted,
        fontSize: 13,
        textAlign: 'center',
        lineHeight: 18,
    },
    badgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        backgroundColor: 'rgba(255,255,255,0.08)',
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: radius.pill,
    },
    badgeDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
        backgroundColor: colors.success,
    },
    badgeText: {
        color: '#fff',
        fontSize: 11,
        fontWeight: '600',
    },
});
