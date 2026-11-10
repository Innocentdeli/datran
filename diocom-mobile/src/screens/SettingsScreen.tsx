import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { checkServer, fetchBillingUsage, type BillingUsageSummary } from '../api/client';
import { getUserEmail, secureStoreAvailable, signOut } from '../auth/session';
import { normalizeServerUrl, type Settings } from '../storage/settings';
import { colors, formatBytes, radius, space } from '../theme';
import {
    Badge,
    Button,
    haptic,
    Icon,
    Notice,
    Row,
    ScreenHeader,
    Section,
    SegmentedControl,
    SwitchRow,
    TextField,
    useToast,
} from '../ui';

interface SettingsScreenProps {
    settings: Settings;
    signedIn: boolean;
    onSave: (settings: Settings) => Promise<void>;
    onOpenAuth?: () => void;
    onOpenPair?: () => void;
}

type Check =
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'ok'; message: string }
    | { kind: 'error'; message: string };

const EXPIRY_OPTIONS = [
    { key: '24', label: '24 Hours' },
    { key: '72', label: '3 Days' },
    { key: '168', label: '7 Days' },
    { key: '720', label: '30 Days' },
];

export function SettingsScreen({ settings, signedIn, onSave, onOpenAuth, onOpenPair }: SettingsScreenProps) {
    const toast = useToast();
    const [serverInput, setServerInput] = useState(settings.serverUrl);
    const [anonymous, setAnonymous] = useState(settings.anonymousUploads);
    const [expiry, setExpiry] = useState(String(settings.defaultExpiryHours ?? 72));
    const [hapticsOn, setHapticsOn] = useState(settings.hapticsEnabled ?? true);
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [check, setCheck] = useState<Check>({ kind: 'idle' });
    const [saving, setSaving] = useState(false);

    const normalized = normalizeServerUrl(serverInput);
    const dirty =
        normalized !== settings.serverUrl ||
        anonymous !== settings.anonymousUploads ||
        Number(expiry) !== settings.defaultExpiryHours ||
        hapticsOn !== settings.hapticsEnabled;

    const handleSave = async (overrides?: Partial<Settings>) => {
        const nextUrl = overrides?.serverUrl ?? normalized;
        if (!nextUrl || saving) return;
        setSaving(true);
        try {
            await onSave({
                serverUrl: nextUrl,
                anonymousUploads: overrides?.anonymousUploads ?? anonymous,
                defaultExpiryHours: overrides?.defaultExpiryHours ?? Number(expiry),
                hapticsEnabled: overrides?.hapticsEnabled ?? hapticsOn,
            });
            haptic.success();
            toast.show('Settings saved');
        } catch (err) {
            haptic.error();
            toast.show(`Could not save: ${err instanceof Error ? err.message : String(err)}`, 'error');
        } finally {
            setSaving(false);
        }
    };

    const testConnection = async () => {
        if (!normalized) return;
        haptic.light();
        setCheck({ kind: 'checking' });
        try {
            const status = await checkServer(normalized);
            if (status >= 500) {
                haptic.warning();
                setCheck({ kind: 'error', message: `Server error (${status})` });
            } else {
                haptic.success();
                setCheck({ kind: 'ok', message: 'Connected' });
            }
        } catch {
            haptic.error();
            setCheck({ kind: 'error', message: 'Unable to reach server' });
        }
    };

    return (
        <View style={styles.container}>
            <ScreenHeader
                title="Settings"
                subtitle="Account, link security, and transfer preferences"
            />

            {/* SECTION 1: ACCOUNT (Clean standard UX: No login/signup forms in settings!) */}
            <Section title="ACCOUNT">
                <AccountSection
                    serverUrl={settings.serverUrl}
                    signedIn={signedIn}
                    onOpenAuth={onOpenAuth}
                />
            </Section>

            {/* SECTION 2: TRANSFER PREFERENCES (Matches Web features) */}
            <Section title="TRANSFER DEFAULTS" footer="Links automatically expire after the selected duration.">
                <View style={styles.sectionInner}>
                    <Text style={styles.settingLabel}>Default Link Expiration</Text>
                    <SegmentedControl
                        value={expiry}
                        onChange={(val) => {
                            setExpiry(val);
                            void handleSave({ defaultExpiryHours: Number(val) });
                        }}
                        segments={EXPIRY_OPTIONS}
                    />
                </View>
                <SwitchRow
                    icon="shield-outline"
                    title="Allow Anonymous Transfers"
                    subtitle="Send files without saving them to your account history"
                    value={anonymous}
                    onChange={(val) => {
                        setAnonymous(val);
                        void handleSave({ anonymousUploads: val });
                    }}
                />
            </Section>

            {/* SECTION 3: APP PREFERENCES & DESKTOP PAIRING */}
            <Section title="PREFERENCES">
                <Row
                    icon="qr-code-outline"
                    title="Pair with Desktop"
                    subtitle="Sync and receive files directly from your computer"
                    onPress={onOpenPair}
                    chevron
                />
                <SwitchRow
                    icon="phone-portrait-outline"
                    title="Haptic Feedback"
                    subtitle="Vibrate on taps and transfer events"
                    value={hapticsOn}
                    onChange={(val) => {
                        setHapticsOn(val);
                        void handleSave({ hapticsEnabled: val });
                    }}
                />
                <Row
                    icon="moon-outline"
                    title="Appearance"
                    value="Cyber Dark"
                />
            </Section>

            {/* SECTION 4: SERVER CONNECTION (ADVANCED / SELF-HOSTING) */}
            <Section
                title="SERVER CONNECTION"
                right={
                    <Button
                        label={showAdvanced ? 'Hide' : 'Configure'}
                        variant="ghost"
                        size="sm"
                        onPress={() => setShowAdvanced((v) => !v)}
                    />
                }
            >
                {showAdvanced ? (
                    <View style={styles.advancedBox}>
                        <TextField
                            label="SERVER ENDPOINT"
                            value={serverInput}
                            onChangeText={(t) => {
                                setServerInput(t);
                                setCheck({ kind: 'idle' });
                            }}
                            placeholder="https://datran.app or http://localhost:3001"
                            icon="globe-outline"
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="url"
                            hint="Connects to your custom or self-hosted Datran instance."
                        />

                        <View style={styles.testRow}>
                            <Button
                                label="Test Connection"
                                icon="pulse-outline"
                                variant="secondary"
                                size="sm"
                                loading={check.kind === 'checking'}
                                disabled={!normalized || check.kind === 'checking'}
                                onPress={testConnection}
                            />
                            {check.kind === 'ok' ? (
                                <Badge label={check.message} tone="success" icon="checkmark-circle" />
                            ) : null}
                            {check.kind === 'error' ? (
                                <Badge label={check.message} tone="danger" icon="alert-circle" />
                            ) : null}
                        </View>

                        {dirty ? (
                            <View style={styles.saveAction}>
                                <Button
                                    label="Save Endpoint"
                                    variant="primary"
                                    size="md"
                                    loading={saving}
                                    onPress={() => handleSave()}
                                />
                            </View>
                        ) : null}
                    </View>
                ) : (
                    <Row
                        icon="server-outline"
                        title="Instance URL"
                        value={settings.serverUrl.replace(/^https?:\/\//, '')}
                        onPress={() => setShowAdvanced(true)}
                        chevron
                    />
                )}
            </Section>

            {/* SECTION 5: ABOUT & PRIVACY */}
            <Section title="ABOUT DATRAN">
                <Row
                    icon="shield-checkmark-outline"
                    title="Zero-Knowledge Security"
                    subtitle="Files are end-to-end encrypted and transferred with private keys"
                />
                <Row
                    icon="information-circle-outline"
                    title="Datran Mobile"
                    value="v1.0.0"
                />
            </Section>
        </View>
    );
}

function AccountSection({
    serverUrl,
    signedIn,
    onOpenAuth,
}: {
    serverUrl: string;
    signedIn: boolean;
    onOpenAuth?: () => void;
}) {
    const toast = useToast();
    const [userEmail, setUserEmail] = useState<string | null>(null);
    const [billing, setBilling] = useState<BillingUsageSummary | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (signedIn) {
            void getUserEmail().then((em) => setUserEmail(em));
            void fetchBillingUsage(serverUrl).then((b) => setBilling(b));
        } else {
            setUserEmail(null);
            setBilling(null);
        }
    }, [signedIn, serverUrl]);

    if (!secureStoreAvailable) {
        return (
            <View style={styles.cardPadding}>
                <Notice
                    tone="info"
                    title="Native Keychain Required"
                    message="Sign-in credential storage is enabled when running on native iOS or Android."
                />
            </View>
        );
    }

    if (signedIn) {
        const planName = billing?.plan.name ?? 'Free Plan';
        const isPro = billing?.plan.id === 'pro';
        const maxFileStr = billing?.plan.maxFileBytes ? formatBytes(billing.plan.maxFileBytes) : '2 GB';
        const maxExpiryHours = billing?.plan.maxExpiryHours ?? 168;
        const maxDays = Math.round(maxExpiryHours / 24);

        return (
            <View style={styles.cardPadding}>
                <View style={styles.profileRow}>
                    <View style={styles.avatar}>
                        <Icon name="person" size={22} color={colors.primary} />
                    </View>
                    <View style={styles.profileDetails}>
                        <Text style={styles.profileEmail} numberOfLines={1}>
                            {userEmail ?? 'Authenticated User'}
                        </Text>
                        <Text style={styles.profilePlan}>
                            {planName} · Up to {maxFileStr} per file
                        </Text>
                    </View>
                    <Badge label={isPro ? 'PRO' : 'FREE'} tone={isPro ? 'primary' : 'neutral'} />
                </View>

                {billing?.usage?.storageBytes !== undefined ? (
                    <View style={styles.quotaBox}>
                        <Text style={styles.quotaText}>
                            Storage: {formatBytes(billing.usage.storageBytes)} used
                            {billing.usage.storageQuotaBytes ? ` of ${formatBytes(billing.usage.storageQuotaBytes)}` : ''}
                        </Text>
                        <Text style={styles.quotaSub}>
                            Link lifetime: Up to {maxDays} days
                        </Text>
                    </View>
                ) : null}

                <View style={styles.signOutWrap}>
                    <Button
                        label="Sign Out"
                        icon="log-out-outline"
                        variant="secondary"
                        size="sm"
                        loading={busy}
                        disabled={busy}
                        onPress={async () => {
                            haptic.medium();
                            setBusy(true);
                            await signOut();
                            setBusy(false);
                            toast.show('Signed out');
                        }}
                    />
                </View>
            </View>
        );
    }

    // When signed out: Standard mobile UX row with chevron leading to AuthModal
    return (
        <Row
            icon="person-circle-outline"
            title="Sign In or Create Account"
            subtitle="Access your cloud vault, send up to 50 GB, and sync active links"
            onPress={onOpenAuth}
            chevron
        />
    );
}

const styles = StyleSheet.create({
    container: {
        gap: space.md,
    },
    cardPadding: {
        padding: space.lg,
        gap: space.md,
    },
    sectionInner: {
        padding: space.lg,
        gap: space.sm,
    },
    settingLabel: {
        color: colors.textMuted,
        fontSize: 13,
        fontWeight: '600',
    },
    profileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
    },
    avatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    profileDetails: {
        flex: 1,
        gap: 2,
    },
    profileEmail: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    profilePlan: {
        color: colors.textMuted,
        fontSize: 12,
    },
    quotaBox: {
        backgroundColor: colors.backgroundElevated,
        borderRadius: radius.md,
        padding: space.md,
        gap: 4,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.border,
    },
    quotaText: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    quotaSub: {
        color: colors.textFaint,
        fontSize: 12,
    },
    signOutWrap: {
        alignItems: 'flex-start',
        marginTop: space.xs,
    },
    advancedBox: {
        padding: space.lg,
        gap: space.md,
    },
    testRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    saveAction: {
        marginTop: space.xs,
    },
});
