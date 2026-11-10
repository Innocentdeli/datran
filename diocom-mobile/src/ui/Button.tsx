import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { colors, HIT, radius, space } from '../theme';
import { haptic } from './haptics';
import { Icon, type IconName } from './Icon';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'tonal';
type Size = 'md' | 'lg' | 'sm';

interface ButtonProps {
    label: string;
    onPress?: () => void;
    variant?: Variant;
    size?: Size;
    icon?: IconName;
    iconRight?: IconName;
    loading?: boolean;
    disabled?: boolean;
    fullWidth?: boolean;
    style?: StyleProp<ViewStyle>;
    accessibilityHint?: string;
    accessibilityRole?: 'button' | 'link';
}

const PALETTE: Record<Variant, { bg: string; bgPressed: string; fg: string; border?: string }> = {
    primary: { bg: colors.primary, bgPressed: colors.primaryPressed, fg: colors.onPrimary },
    secondary: { bg: colors.surfaceRaised, bgPressed: colors.surfacePressed, fg: colors.text, border: colors.borderStrong },
    tonal: { bg: colors.primarySoft, bgPressed: 'rgba(0,242,255,0.18)', fg: colors.primary, border: colors.primaryBorder },
    ghost: { bg: 'transparent', bgPressed: colors.surfaceRaised, fg: colors.text },
    danger: { bg: colors.dangerSoft, bgPressed: 'rgba(239,68,68,0.2)', fg: colors.danger, border: 'rgba(239,68,68,0.3)' },
};

const HEIGHT: Record<Size, number> = { sm: 36, md: HIT + 4, lg: 56 };

export function Button({
    label,
    onPress,
    variant = 'primary',
    size = 'md',
    icon,
    iconRight,
    loading = false,
    disabled = false,
    fullWidth = false,
    style,
    accessibilityHint,
    accessibilityRole = 'button',
}: ButtonProps) {
    const p = PALETTE[variant];
    const inactive = disabled || loading;
    const fontSize = size === 'lg' ? 17 : size === 'sm' ? 13 : 15;
    const iconSize = size === 'lg' ? 20 : size === 'sm' ? 15 : 18;

    return (
        <Pressable
            onPress={() => {
                haptic.light();
                onPress?.();
            }}
            disabled={inactive}
            accessibilityRole={accessibilityRole}
            accessibilityLabel={label}
            accessibilityHint={accessibilityHint}
            accessibilityState={{ disabled: inactive, busy: loading }}
            hitSlop={size === 'sm' ? 6 : 0}
            style={({ pressed }) => [
                styles.base,
                {
                    minHeight: HEIGHT[size],
                    paddingHorizontal: size === 'sm' ? space.md : space.xl,
                    backgroundColor: pressed ? p.bgPressed : p.bg,
                    borderColor: p.border ?? 'transparent',
                    borderWidth: p.border ? StyleSheet.hairlineWidth * 2 : 0,
                    transform: [{ scale: pressed ? 0.98 : 1 }],
                },
                fullWidth && styles.full,
                disabled && !loading && styles.disabled,
                style,
            ]}
        >
            {loading ? (
                <ActivityIndicator color={p.fg} />
            ) : (
                <View style={styles.row}>
                    {icon ? <Icon name={icon} size={iconSize} color={p.fg} /> : null}
                    <Text style={[styles.label, { color: p.fg, fontSize }]} numberOfLines={1}>
                        {label}
                    </Text>
                    {iconRight ? <Icon name={iconRight} size={iconSize} color={p.fg} /> : null}
                </View>
            )}
        </Pressable>
    );
}

interface IconButtonProps {
    icon: IconName;
    label: string;
    onPress?: () => void;
    tint?: string;
    background?: string;
    size?: number;
    disabled?: boolean;
    children?: ReactNode;
}

/** Circular icon-only button with a 44pt target and an accessible label. */
export function IconButton({ icon, label, onPress, tint = colors.text, background = colors.surfaceRaised, size = 40, disabled }: IconButtonProps) {
    return (
        <Pressable
            onPress={() => {
                haptic.tap();
                onPress?.();
            }}
            disabled={disabled}
            accessibilityRole="button"
            accessibilityLabel={label}
            hitSlop={Math.max(0, (HIT - size) / 2)}
            style={({ pressed }) => [
                styles.iconBtn,
                { width: size, height: size, borderRadius: size / 2, backgroundColor: pressed ? colors.surfacePressed : background },
                disabled && styles.disabled,
            ]}
        >
            <Icon name={icon} size={Math.round(size * 0.48)} color={tint} />
        </Pressable>
    );
}

const styles = StyleSheet.create({
    base: {
        borderRadius: radius.md,
        alignItems: 'center',
        justifyContent: 'center',
        alignSelf: 'flex-start',
    },
    full: { alignSelf: 'stretch' },
    row: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
    label: { fontWeight: '600', letterSpacing: 0.1 },
    disabled: { opacity: 0.4 },
    iconBtn: { alignItems: 'center', justifyContent: 'center' },
});
