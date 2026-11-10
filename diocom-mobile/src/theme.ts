import { Platform, StyleSheet } from 'react-native';

/**
 * Datran mobile design tokens. Mirrors the web portal (diocom-app/src/app/globals.css) so both clients
 * read as one product: cyan primary, deep navy surfaces, semantic success/warning/error.
 */
export const colors = {
    background: '#050505',
    backgroundElevated: '#070B12',
    surface: '#0A0F1A',
    surfaceRaised: '#0F1624',
    surfacePressed: '#141D2E',
    border: 'rgba(255,255,255,0.08)',
    borderStrong: 'rgba(255,255,255,0.14)',

    text: '#F8FAFC',
    textMuted: '#94A3B8',
    textFaint: '#64748B',

    primary: '#00F2FF',
    primaryPressed: '#00C4D0',
    primarySoft: 'rgba(0,242,255,0.10)',
    primaryBorder: 'rgba(0,242,255,0.28)',
    onPrimary: '#04121A',

    success: '#10B981',
    successSoft: 'rgba(16,185,129,0.12)',
    warning: '#F59E0B',
    warningSoft: 'rgba(245,158,11,0.12)',
    danger: '#EF4444',
    dangerSoft: 'rgba(239,68,68,0.12)',
    info: '#3B82F6',
    infoSoft: 'rgba(59,130,246,0.12)',
    violet: '#8B5CF6',
    violetSoft: 'rgba(139,92,246,0.12)',

    overlay: 'rgba(2,6,23,0.72)',

    /** @deprecated legacy alias kept for any external import; use `primary`. */
    accent: '#00F2FF',
    /** @deprecated legacy alias; use `primarySoft`. */
    accentSoft: 'rgba(0,242,255,0.10)',
} as const;

/** 4-pt spacing scale. */
export const space = {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    xxl: 24,
    xxxl: 32,
} as const;

export const radius = {
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    pill: 999,
} as const;

/** Minimum touch target (Apple HIG 44pt / Material 48dp). */
export const HIT = 44;

const fontFamily = Platform.select({ ios: 'System', android: 'sans-serif', default: undefined });

/** Type scale tuned for readability (no all-caps body copy, generous line heights). */
export const type = StyleSheet.create({
    largeTitle: { fontFamily, fontSize: 32, lineHeight: 38, fontWeight: '800', letterSpacing: -0.6, color: colors.text },
    title: { fontFamily, fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3, color: colors.text },
    headline: { fontFamily, fontSize: 17, lineHeight: 22, fontWeight: '600', color: colors.text },
    body: { fontFamily, fontSize: 15, lineHeight: 21, fontWeight: '400', color: colors.text },
    callout: { fontFamily, fontSize: 14, lineHeight: 20, fontWeight: '400', color: colors.textMuted },
    footnote: { fontFamily, fontSize: 13, lineHeight: 18, fontWeight: '400', color: colors.textMuted },
    caption: { fontFamily, fontSize: 12, lineHeight: 16, fontWeight: '500', color: colors.textFaint },
    overline: { fontFamily, fontSize: 12, lineHeight: 16, fontWeight: '600', letterSpacing: 0.6, color: colors.textFaint, textTransform: 'uppercase' },
    mono: { fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }), fontSize: 13, lineHeight: 18, color: colors.primary },
});

export const shadow = Platform.select({
    ios: { shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    android: { elevation: 6 },
    default: {},
});

export const glow = Platform.select({
    ios: { shadowColor: colors.primary, shadowOpacity: 0.35, shadowRadius: 20, shadowOffset: { width: 0, height: 0 } },
    default: {},
});

export function formatBytes(bytes: number | undefined | null): string {
    if (bytes === undefined || bytes === null || !Number.isFinite(bytes)) return 'Unknown size';
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

/** "Just now", "5 min ago", "Yesterday", "Mar 4". */
export function formatRelativeTime(epochMs: number, now = Date.now()): string {
    const diff = now - epochMs;
    const min = 60_000;
    const hour = 60 * min;
    const day = 24 * hour;
    if (diff < min) return 'Just now';
    if (diff < hour) return `${Math.floor(diff / min)} min ago`;
    if (diff < day) return `${Math.floor(diff / hour)} h ago`;
    if (diff < 2 * day) return 'Yesterday';
    if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
    return new Date(epochMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "in 3 days", "today", "expired". */
export function formatExpiry(epochMs: number | null | undefined, now = Date.now()): string | null {
    if (!epochMs) return null;
    const diff = epochMs - now;
    if (diff <= 0) return 'Expired';
    const days = Math.ceil(diff / 86_400_000);
    if (days <= 1) return 'Expires today';
    return `Expires in ${days} days`;
}

/** Bytes/sec → "12.4 MB/s". */
export function formatRate(bytesPerSec: number): string {
    if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
    return `${formatBytes(bytesPerSec)}/s`;
}

/** Seconds → "1m 20s" / "45s". */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s ? `${m}m ${s}s` : `${m}m`;
}

/** Hostname for display ("datran.app" or "localhost:3001"). */
export function displayHost(url: string): string {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}
