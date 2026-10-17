import { StyleSheet } from 'react-native';

export const colors = {
    background: '#050505',
    surface: 'rgba(255,255,255,0.04)',
    border: 'rgba(255,255,255,0.08)',
    text: '#ffffff',
    textMuted: '#9a9a9a',
    textFaint: '#5c5c5c',
    accent: '#00F2FF',
    accentSoft: 'rgba(0,242,255,0.08)',
    danger: '#ff5c7a',
    success: '#4ade80',
} as const;

export const shared = StyleSheet.create({
    card: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 16,
        padding: 20,
        marginBottom: 16,
    },
    cardLabel: {
        color: colors.accent,
        fontSize: 11,
        fontWeight: '800',
        letterSpacing: 1.5,
        marginBottom: 12,
    },
    screenTitle: {
        color: colors.text,
        fontSize: 26,
        fontWeight: '900',
        letterSpacing: -1,
    },
    screenSubtitle: {
        color: colors.textMuted,
        fontSize: 11,
        letterSpacing: 2,
        textTransform: 'uppercase',
        marginBottom: 24,
    },
    body: {
        color: colors.textMuted,
        fontSize: 14,
        lineHeight: 20,
    },
    button: {
        backgroundColor: colors.accent,
        borderRadius: 12,
        paddingVertical: 14,
        paddingHorizontal: 18,
        alignItems: 'center',
        justifyContent: 'center',
    },
    buttonText: {
        color: '#000',
        fontWeight: '800',
        letterSpacing: 1,
    },
    secondaryButton: {
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    secondaryButtonText: {
        color: colors.text,
        fontWeight: '700',
    },
    disabled: {
        opacity: 0.4,
    },
    input: {
        backgroundColor: 'rgba(0,0,0,0.4)',
        borderColor: colors.border,
        borderWidth: 1,
        borderRadius: 10,
        color: colors.text,
        fontSize: 14,
        paddingHorizontal: 12,
        paddingVertical: 10,
    },
});

export function formatBytes(bytes: number | undefined): string {
    if (bytes === undefined || !Number.isFinite(bytes)) return 'unknown size';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}
