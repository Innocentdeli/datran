import { useEffect, useRef } from 'react';
import { AccessibilityInfo, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, space } from '../theme';
import { haptic } from './haptics';
import { Icon, type IconName } from './Icon';

/* ------------------------------------------------------------ FileIcon */

type Kind = 'image' | 'video' | 'audio' | 'pdf' | 'archive' | 'code' | 'doc' | 'sheet' | 'file';

const KIND: Record<Kind, { icon: IconName; fg: string; bg: string; label: string }> = {
    image: { icon: 'image', fg: '#F472B6', bg: 'rgba(244,114,182,0.12)', label: 'Image' },
    video: { icon: 'videocam', fg: colors.violet, bg: colors.violetSoft, label: 'Video' },
    audio: { icon: 'musical-notes', fg: colors.warning, bg: colors.warningSoft, label: 'Audio' },
    pdf: { icon: 'document-text', fg: colors.danger, bg: colors.dangerSoft, label: 'PDF' },
    archive: { icon: 'archive', fg: '#A3A3A3', bg: 'rgba(163,163,163,0.12)', label: 'Archive' },
    code: { icon: 'code-slash', fg: colors.success, bg: colors.successSoft, label: 'Code' },
    doc: { icon: 'document', fg: colors.info, bg: colors.infoSoft, label: 'Document' },
    sheet: { icon: 'grid', fg: colors.success, bg: colors.successSoft, label: 'Spreadsheet' },
    file: { icon: 'document-outline', fg: colors.primary, bg: colors.primarySoft, label: 'File' },
};

export function fileKind(name: string, mime?: string | null): Kind {
    const m = (mime ?? '').toLowerCase();
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'bmp'].includes(ext)) return 'image';
    if (m.startsWith('video/') || ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v'].includes(ext)) return 'video';
    if (m.startsWith('audio/') || ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg'].includes(ext)) return 'audio';
    if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
    if (['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'].includes(ext)) return 'archive';
    if (['csv', 'xls', 'xlsx', 'numbers', 'parquet'].includes(ext)) return 'sheet';
    if (['doc', 'docx', 'txt', 'md', 'rtf', 'pages', 'ppt', 'pptx', 'key'].includes(ext)) return 'doc';
    if (['js', 'ts', 'tsx', 'py', 'rs', 'go', 'json', 'html', 'css', 'java', 'c', 'cpp', 'sh', 'yml', 'yaml'].includes(ext)) return 'code';
    return 'file';
}

export function fileKindLabel(name: string, mime?: string | null): string {
    return KIND[fileKind(name, mime)].label;
}

export function FileIcon({ name, mime, size = 44 }: { name: string; mime?: string | null; size?: number }) {
    const k = KIND[fileKind(name, mime)];
    return (
        <View style={[styles.fileIcon, { width: size, height: size, borderRadius: size * 0.28, backgroundColor: k.bg }]}>
            <Icon name={k.icon} size={Math.round(size * 0.48)} color={k.fg} />
        </View>
    );
}

/* --------------------------------------------------------- ProgressBar */

/** Smoothly animated determinate bar; indeterminate shimmer when `progress` is null. */
export function ProgressBar({ progress, height = 8, tint = colors.primary }: { progress: number | null; height?: number; tint?: string }) {
    const value = useRef(new Animated.Value(0)).current;
    const shimmer = useRef(new Animated.Value(0)).current;

    useEffect(() => {
        if (progress === null) return;
        Animated.timing(value, { toValue: progress, duration: 220, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    }, [progress, value]);

    useEffect(() => {
        if (progress !== null) return;
        let loop: Animated.CompositeAnimation | null = null;
        let cancelled = false;
        void AccessibilityInfo.isReduceMotionEnabled().then((reduce) => {
            if (reduce || cancelled) return;
            loop = Animated.loop(Animated.timing(shimmer, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.quad), useNativeDriver: false }));
            loop.start();
        });
        return () => {
            cancelled = true;
            loop?.stop();
        };
    }, [progress, shimmer]);

    const width =
        progress === null
            ? '35%'
            : value.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'], extrapolate: 'clamp' });
    const left = progress === null ? shimmer.interpolate({ inputRange: [0, 1], outputRange: ['-35%', '100%'] }) : 0;

    return (
        <View
            style={[styles.track, { height, borderRadius: height / 2 }]}
            accessibilityRole="progressbar"
            accessibilityValue={progress === null ? undefined : { min: 0, max: 100, now: Math.round(progress * 100) }}
        >
            <Animated.View style={[styles.fill, { width, left, backgroundColor: tint, borderRadius: height / 2 }]} />
        </View>
    );
}

/* ---------------------------------------------------- SegmentedControl */

interface Segment<T extends string> {
    key: T;
    label: string;
    count?: number;
}

export function SegmentedControl<T extends string>({ segments, value, onChange }: { segments: Segment<T>[]; value: T; onChange: (v: T) => void }) {
    return (
        <View style={styles.segWrap} accessibilityRole="tablist">
            {segments.map((s) => {
                const active = s.key === value;
                return (
                    <Pressable
                        key={s.key}
                        onPress={() => {
                            if (!active) haptic.tap();
                            onChange(s.key);
                        }}
                        accessibilityRole="tab"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={s.count !== undefined ? `${s.label}, ${s.count}` : s.label}
                        style={[styles.seg, active && styles.segActive]}
                    >
                        <Text style={[styles.segText, active && styles.segTextActive]} numberOfLines={1}>
                            {s.label}
                        </Text>
                        {s.count !== undefined ? (
                            <View style={[styles.segCount, active && { backgroundColor: colors.primarySoft }]}>
                                <Text style={[styles.segCountText, active && { color: colors.primary }]}>{s.count}</Text>
                            </View>
                        ) : null}
                    </Pressable>
                );
            })}
        </View>
    );
}

/* ---------------------------------------------------------------- StatTile */

export function StatTile({ icon, label, value, tint = colors.primary }: { icon: IconName; label: string; value: string; tint?: string }) {
    return (
        <View style={styles.stat} accessible accessibilityLabel={`${label}: ${value}`}>
            <Icon name={icon} size={16} color={tint} />
            <Text style={styles.statValue} numberOfLines={1} adjustsFontSizeToFit>
                {value}
            </Text>
            <Text style={styles.statLabel} numberOfLines={1}>
                {label}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create({
    fileIcon: { alignItems: 'center', justifyContent: 'center' },

    track: { width: '100%', backgroundColor: colors.surfacePressed, overflow: 'hidden' },
    fill: { position: 'absolute', top: 0, bottom: 0 },

    segWrap: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.md, padding: 3, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.border },
    seg: { flex: 1, minHeight: 38, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: radius.sm + 1 },
    segActive: { backgroundColor: colors.surfaceRaised },
    segText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
    segTextActive: { color: colors.text },
    segCount: { minWidth: 20, paddingHorizontal: 6, height: 18, borderRadius: 9, backgroundColor: colors.surfacePressed, alignItems: 'center', justifyContent: 'center' },
    segCountText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },

    stat: { flex: 1, backgroundColor: colors.backgroundElevated, borderRadius: radius.md, padding: space.md, gap: 4, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.border },
    statValue: { color: colors.text, fontSize: 16, fontWeight: '700' },
    statLabel: { color: colors.textFaint, fontSize: 12, fontWeight: '500' },
});
