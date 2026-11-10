import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space } from '../theme';
import { Icon, type IconName } from './Icon';

interface RadarPulseProps {
    size?: number;
    icon?: IconName;
    statusText?: string;
    subText?: string;
}

export function RadarPulse({
    size = 120,
    icon = 'radio-outline',
    statusText = 'Local Wi-Fi Radar Active',
    subText = 'Zero-internet peer discovery enabled',
}: RadarPulseProps) {
    const pulse1 = useRef(new Animated.Value(0)).current;
    const pulse2 = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        const createPulse = (anim: Animated.Value, delay: number) => {
            return Animated.loop(
                Animated.sequence([
                    Animated.delay(delay),
                    Animated.timing(anim, {
                        toValue: 1,
                        duration: 2400,
                        easing: Easing.out(Easing.ease),
                        useNativeDriver: true,
                    }),
                    Animated.timing(anim, {
                        toValue: 0,
                        duration: 0,
                        useNativeDriver: true,
                    }),
                ])
            );
        };

        const anim1 = createPulse(pulse1, 0);
        const anim2 = createPulse(pulse2, 1200);

        anim1.start();
        anim2.start();

        return () => {
            anim1.stop();
            anim2.stop();
        };
    }, [pulse1, pulse2]);

    const halfSize = size / 2;

    const scale1 = pulse1.interpolate({
        inputRange: [0, 1],
        outputRange: [0.6, 1.4],
    });

    const opacity1 = pulse1.interpolate({
        inputRange: [0, 0.4, 1],
        outputRange: [0.6, 0.3, 0],
    });

    const scale2 = pulse2.interpolate({
        inputRange: [0, 1],
        outputRange: [0.6, 1.4],
    });

    const opacity2 = pulse2.interpolate({
        inputRange: [0, 0.4, 1],
        outputRange: [0.6, 0.3, 0],
    });

    return (
        <View style={styles.container}>
            <View style={[styles.radarBox, { width: size, height: size }]}>
                {/* Expanding Wave 1 */}
                <Animated.View
                    style={[
                        styles.wave,
                        {
                            width: size,
                            height: size,
                            borderRadius: halfSize,
                            transform: [{ scale: scale1 }],
                            opacity: opacity1,
                        },
                    ]}
                />

                {/* Expanding Wave 2 */}
                <Animated.View
                    style={[
                        styles.wave,
                        {
                            width: size,
                            height: size,
                            borderRadius: halfSize,
                            transform: [{ scale: scale2 }],
                            opacity: opacity2,
                        },
                    ]}
                />

                {/* Central Glowing Orb */}
                <View style={[styles.centerOrb, { width: size * 0.45, height: size * 0.45, borderRadius: (size * 0.45) / 2 }]}>
                    <Icon name={icon} size={24} color={colors.primary} />
                </View>
            </View>

            {statusText ? (
                <View style={styles.textContainer}>
                    <View style={styles.badgeRow}>
                        <View style={styles.liveDot} />
                        <Text style={styles.statusText}>{statusText}</Text>
                    </View>
                    {subText ? <Text style={styles.subText}>{subText}</Text> : null}
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: space.md,
    },
    radarBox: {
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    wave: {
        position: 'absolute',
        borderWidth: 1.5,
        borderColor: colors.primary,
        backgroundColor: colors.primarySoft,
    },
    centerOrb: {
        backgroundColor: 'rgba(0, 242, 255, 0.15)',
        borderWidth: 1.5,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 0 },
        shadowOpacity: 0.5,
        shadowRadius: 12,
        elevation: 8,
    },
    textContainer: {
        alignItems: 'center',
        marginTop: space.md,
        gap: 4,
    },
    badgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    liveDot: {
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: colors.success,
    },
    statusText: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.2,
    },
    subText: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '500',
    },
});
