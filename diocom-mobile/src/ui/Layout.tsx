import type { ReactNode } from 'react';
import {
    Pressable,
    StyleSheet,
    Switch,
    Text,
    View,
    type StyleProp,
    type ViewStyle,
} from 'react-native';

import { colors, HIT, radius, space, type } from '../theme';
import { haptic } from './haptics';
import { Icon, type IconName } from './Icon';

/* ------------------------------------------------------------------ Card */

export function Card({ children, style, padded = true }: { children: ReactNode; style?: StyleProp<ViewStyle>; padded?: boolean }) {
    return <View style={[styles.card, padded && styles.cardPadded, style]}>{children}</View>;
}

/* --------------------------------------------------------- ScreenHeader */

interface ScreenHeaderProps {
    title: string;
    subtitle?: string;
    right?: ReactNode;
}

/** Large-title header (iOS-style), left aligned, with an optional trailing action. */
export function ScreenHeader({ title, subtitle, right }: ScreenHeaderProps) {
    return (
        <View style={styles.header}>
            <View style={styles.flex}>
                <Text style={type.largeTitle} accessibilityRole="header">
                    {title}
                </Text>
                {subtitle ? <Text style={[type.callout, styles.headerSub]}>{subtitle}</Text> : null}
            </View>
            {right}
        </View>
    );
}

/* ------------------------------------------------------- Grouped section */

interface SectionProps {
    title?: string;
    footer?: string;
    children: ReactNode;
    right?: ReactNode;
}

/** Inset grouped list section (Settings.app pattern). Children should be <Row /> elements. */
export function Section({ title, footer, children, right }: SectionProps) {
    const items = Array.isArray(children) ? children.filter(Boolean) : [children];
    return (
        <View style={styles.section}>
            {title || right ? (
                <View style={styles.sectionHead}>
                    {title ? <Text style={type.overline}>{title}</Text> : <View />}
                    {right}
                </View>
            ) : null}
            <View style={styles.sectionBody}>
                {items.map((child, i) => (
                    <View key={i}>
                        {i > 0 ? <View style={styles.divider} /> : null}
                        {child}
                    </View>
                ))}
            </View>
            {footer ? <Text style={[type.footnote, styles.sectionFoot]}>{footer}</Text> : null}
        </View>
    );
}

interface RowProps {
    icon?: IconName;
    iconTint?: string;
    iconBg?: string;
    title: string;
    subtitle?: string;
    value?: string;
    onPress?: () => void;
    chevron?: boolean;
    destructive?: boolean;
    right?: ReactNode;
    accessibilityHint?: string;
}

export function Row({ icon, iconTint = colors.primary, iconBg = colors.primarySoft, title, subtitle, value, onPress, chevron, destructive, right, accessibilityHint }: RowProps) {
    const content = (
        <>
            {icon ? (
                <View style={[styles.rowIcon, { backgroundColor: destructive ? colors.dangerSoft : iconBg }]}>
                    <Icon name={icon} size={17} color={destructive ? colors.danger : iconTint} />
                </View>
            ) : null}
            <View style={styles.flex}>
                <Text style={[type.body, destructive && { color: colors.danger }]} numberOfLines={1}>
                    {title}
                </Text>
                {subtitle ? (
                    <Text style={[type.footnote, styles.rowSub]} numberOfLines={2}>
                        {subtitle}
                    </Text>
                ) : null}
            </View>
            {value ? (
                <Text style={[type.callout, styles.rowValue]} numberOfLines={1}>
                    {value}
                </Text>
            ) : null}
            {right}
            {chevron ? <Icon name="chevron-forward" size={18} color={colors.textFaint} /> : null}
        </>
    );

    if (!onPress) return <View style={styles.row}>{content}</View>;
    return (
        <Pressable
            onPress={() => {
                haptic.tap();
                onPress();
            }}
            accessibilityRole="button"
            accessibilityLabel={value ? `${title}, ${value}` : title}
            accessibilityHint={accessibilityHint}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfacePressed }]}
        >
            {content}
        </Pressable>
    );
}

interface SwitchRowProps {
    icon?: IconName;
    title: string;
    subtitle?: string;
    value: boolean;
    onChange: (v: boolean) => void;
}

export function SwitchRow({ icon, title, subtitle, value, onChange }: SwitchRowProps) {
    return (
        <Row
            icon={icon}
            title={title}
            subtitle={subtitle}
            right={
                <Switch
                    value={value}
                    onValueChange={(v) => {
                        haptic.tap();
                        onChange(v);
                    }}
                    trackColor={{ true: colors.primary, false: colors.surfacePressed }}
                    thumbColor={colors.text}
                    ios_backgroundColor={colors.surfacePressed}
                    accessibilityLabel={title}
                />
            }
        />
    );
}

/* ---------------------------------------------------------------- Badge */

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'violet';

const BADGE: Record<BadgeTone, { bg: string; fg: string }> = {
    neutral: { bg: colors.surfacePressed, fg: colors.textMuted },
    primary: { bg: colors.primarySoft, fg: colors.primary },
    success: { bg: colors.successSoft, fg: colors.success },
    warning: { bg: colors.warningSoft, fg: colors.warning },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    violet: { bg: colors.violetSoft, fg: colors.violet },
};

export function Badge({ label, tone = 'neutral', icon }: { label: string; tone?: BadgeTone; icon?: IconName }) {
    const t = BADGE[tone];
    return (
        <View style={[styles.badge, { backgroundColor: t.bg }]}>
            {icon ? <Icon name={icon} size={12} color={t.fg} /> : null}
            <Text style={[styles.badgeText, { color: t.fg }]} numberOfLines={1}>
                {label}
            </Text>
        </View>
    );
}

/* ----------------------------------------------------------- EmptyState */

interface EmptyStateProps {
    icon: IconName;
    title: string;
    message: string;
    action?: ReactNode;
}

export function EmptyState({ icon, title, message, action }: EmptyStateProps) {
    return (
        <View style={styles.empty}>
            <View style={styles.emptyIcon}>
                <Icon name={icon} size={30} color={colors.primary} />
            </View>
            <Text style={[type.headline, styles.center]}>{title}</Text>
            <Text style={[type.callout, styles.center, styles.emptyMsg]}>{message}</Text>
            {action ? <View style={styles.emptyAction}>{action}</View> : null}
        </View>
    );
}

/* ---------------------------------------------------------- InlineNotice */

export function Notice({ tone = 'info', title, message, action }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title?: string; message: string; action?: ReactNode }) {
    const map = {
        info: { bg: colors.primarySoft, fg: colors.primary, icon: 'information-circle' as IconName, border: colors.primaryBorder },
        warning: { bg: colors.warningSoft, fg: colors.warning, icon: 'warning' as IconName, border: 'rgba(245,158,11,0.3)' },
        danger: { bg: colors.dangerSoft, fg: colors.danger, icon: 'alert-circle' as IconName, border: 'rgba(239,68,68,0.3)' },
        success: { bg: colors.successSoft, fg: colors.success, icon: 'checkmark-circle' as IconName, border: 'rgba(16,185,129,0.3)' },
    }[tone];
    return (
        <View style={[styles.notice, { backgroundColor: map.bg, borderColor: map.border }]} accessibilityRole="alert">
            <Icon name={map.icon} size={20} color={map.fg} />
            <View style={styles.flex}>
                {title ? <Text style={[type.headline, { color: map.fg, fontSize: 15 }]}>{title}</Text> : null}
                <Text style={[type.footnote, { color: colors.text }]}>{message}</Text>
                {action ? <View style={{ marginTop: space.sm }}>{action}</View> : null}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    flex: { flex: 1, minWidth: 0 },
    center: { textAlign: 'center' },
    card: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderRadius: radius.xl,
        overflow: 'hidden',
    },
    cardPadded: { padding: space.xl },

    header: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md, marginBottom: space.xxl },
    headerSub: { marginTop: space.xs },

    section: { marginBottom: space.xxl },
    sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.xs, marginBottom: space.sm },
    sectionBody: {
        backgroundColor: colors.surface,
        borderColor: colors.border,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderRadius: radius.lg,
        overflow: 'hidden',
    },
    sectionFoot: { paddingHorizontal: space.xs, marginTop: space.sm },
    divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: space.lg },

    row: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: HIT + 8, paddingHorizontal: space.lg, paddingVertical: space.md },
    rowIcon: { width: 30, height: 30, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
    rowSub: { marginTop: 2 },
    rowValue: { maxWidth: '45%' },

    badge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: space.sm, paddingVertical: 3, borderRadius: radius.pill, alignSelf: 'flex-start' },
    badgeText: { fontSize: 11, fontWeight: '600' },

    empty: { alignItems: 'center', paddingVertical: space.xxxl * 1.5, paddingHorizontal: space.xxl },
    emptyIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center', marginBottom: space.lg },
    emptyMsg: { marginTop: space.xs, maxWidth: 300 },
    emptyAction: { marginTop: space.xl },

    notice: { flexDirection: 'row', gap: space.md, padding: space.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth * 2 },
});
