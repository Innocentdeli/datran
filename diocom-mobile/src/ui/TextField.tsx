import { forwardRef, useState, type ElementRef } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from 'react-native';

import { colors, HIT, radius, space, type } from '../theme';
import { Icon, type IconName } from './Icon';

interface TextFieldProps extends Omit<TextInputProps, 'style'> {
    label: string;
    hint?: string;
    error?: string | null;
    icon?: IconName;
    /** Shows a show/hide toggle for password fields. */
    revealable?: boolean;
}

/** Labelled input with focus ring, hint/error text and optional leading icon. */
export const TextField = forwardRef<ElementRef<typeof TextInput>, TextFieldProps>(function TextField(
    { label, hint, error, icon, revealable, secureTextEntry, ...rest },
    ref,
) {
    const [focused, setFocused] = useState(false);
    const [hidden, setHidden] = useState(true);
    const borderColor = error ? colors.danger : focused ? colors.primary : colors.borderStrong;

    return (
        <View style={styles.wrap}>
            <Text style={styles.label}>{label}</Text>
            <View style={[styles.field, { borderColor }, focused && styles.focused]}>
                {icon ? <Icon name={icon} size={18} color={focused ? colors.primary : colors.textFaint} /> : null}
                <TextInput
                    ref={ref}
                    {...rest}
                    secureTextEntry={revealable ? hidden : secureTextEntry}
                    onFocus={(e) => {
                        setFocused(true);
                        rest.onFocus?.(e);
                    }}
                    onBlur={(e) => {
                        setFocused(false);
                        rest.onBlur?.(e);
                    }}
                    placeholderTextColor={colors.textFaint}
                    selectionColor={colors.primary}
                    accessibilityLabel={label}
                    accessibilityHint={error ?? hint}
                    style={styles.input}
                />
                {revealable ? (
                    <Pressable
                        onPress={() => setHidden((h) => !h)}
                        accessibilityRole="button"
                        accessibilityLabel={hidden ? 'Show password' : 'Hide password'}
                        hitSlop={10}
                    >
                        <Icon name={hidden ? 'eye-outline' : 'eye-off-outline'} size={20} color={colors.textMuted} />
                    </Pressable>
                ) : null}
            </View>
            {error ? (
                <View style={styles.msgRow}>
                    <Icon name="alert-circle" size={14} color={colors.danger} />
                    <Text style={[type.footnote, { color: colors.danger, flex: 1 }]}>{error}</Text>
                </View>
            ) : hint ? (
                <Text style={[type.footnote, styles.hint]}>{hint}</Text>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create({
    wrap: { marginBottom: space.lg },
    label: { color: colors.textMuted, fontSize: 13, fontWeight: '600', marginBottom: space.sm, marginLeft: 2 },
    field: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        minHeight: HIT + 4,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderWidth: 1,
        backgroundColor: colors.backgroundElevated,
    },
    focused: { backgroundColor: colors.surface },
    input: { flex: 1, color: colors.text, fontSize: 16, paddingVertical: space.md },
    hint: { marginTop: space.sm, marginLeft: 2 },
    msgRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: space.sm, marginLeft: 2 },
});
