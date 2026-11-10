import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccessibilityInfo, Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, radius, shadow, space } from '../theme';
import { haptic } from './haptics';
import { Icon, type IconName } from './Icon';

type Tone = 'success' | 'error' | 'info';

interface ToastMessage {
    id: number;
    text: string;
    tone: Tone;
}

interface ToastApi {
    show: (text: string, tone?: Tone) => void;
}

const ToastContext = createContext<ToastApi>({ show: () => undefined });

export function useToast(): ToastApi {
    return useContext(ToastContext);
}

const TONE: Record<Tone, { icon: IconName; color: string }> = {
    success: { icon: 'checkmark-circle', color: colors.success },
    error: { icon: 'alert-circle', color: colors.danger },
    info: { icon: 'information-circle', color: colors.primary },
};

/**
 * Non-blocking feedback ("Link copied", "Signed in"). Announced to screen readers, auto-dismisses,
 * sits above the tab bar so it never covers primary actions.
 */
export function ToastProvider({ children, bottomOffset = 96 }: { children: ReactNode; bottomOffset?: number }) {
    const insets = useSafeAreaInsets();
    const [toast, setToast] = useState<ToastMessage | null>(null);
    const anim = useRef(new Animated.Value(0)).current;
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const show = useCallback(
        (text: string, tone: Tone = 'success') => {
            if (timer.current) clearTimeout(timer.current);
            setToast({ id: Date.now(), text, tone });
            if (tone === 'success') haptic.success();
            else if (tone === 'error') haptic.error();
            AccessibilityInfo.announceForAccessibility(text);
            anim.setValue(0);
            Animated.spring(anim, { toValue: 1, useNativeDriver: true, friction: 8, tension: 80 }).start();
            timer.current = setTimeout(() => {
                Animated.timing(anim, { toValue: 0, duration: 180, useNativeDriver: true }).start(() => setToast(null));
            }, 2200);
        },
        [anim],
    );

    useEffect(() => () => {
        if (timer.current) clearTimeout(timer.current);
    }, []);

    const api = useMemo(() => ({ show }), [show]);
    const tone = toast ? TONE[toast.tone] : null;

    return (
        <ToastContext.Provider value={api}>
            {children}
            {toast && tone ? (
                <Animated.View
                    pointerEvents="none"
                    style={[
                        styles.wrap,
                        {
                            bottom: insets.bottom + bottomOffset,
                            opacity: anim,
                            transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }],
                        },
                    ]}
                >
                    <View style={styles.toast} accessibilityLiveRegion="polite">
                        <Icon name={tone.icon} size={20} color={tone.color} />
                        <Text style={styles.text} numberOfLines={2}>
                            {toast.text}
                        </Text>
                    </View>
                </Animated.View>
            ) : null}
        </ToastContext.Provider>
    );
}

const styles = StyleSheet.create({
    wrap: { position: 'absolute', left: space.lg, right: space.lg, alignItems: 'center' },
    toast: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        backgroundColor: colors.surfaceRaised,
        borderColor: colors.borderStrong,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderRadius: radius.pill,
        paddingVertical: space.md,
        paddingHorizontal: space.lg,
        maxWidth: 480,
        ...shadow,
    },
    text: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
});
