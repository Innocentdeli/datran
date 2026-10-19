import { useState } from 'react';
import { ActivityIndicator, StyleSheet, Switch, Text, TextInput, TouchableOpacity, View } from 'react-native';

import { checkServer } from '../api/client';
import { AuthError, secureStoreAvailable, signIn, signOut } from '../auth/session';
import { normalizeServerUrl, type Settings } from '../storage/settings';
import { colors, shared } from '../theme';

interface SettingsScreenProps {
    settings: Settings;
    signedIn: boolean;
    onSave: (settings: Settings) => Promise<void>;
}

type Check = { kind: 'idle' } | { kind: 'checking' } | { kind: 'ok'; message: string } | { kind: 'error'; message: string };

export function SettingsScreen({ settings, signedIn, onSave }: SettingsScreenProps) {
    const [serverInput, setServerInput] = useState(settings.serverUrl);
    const [anonymous, setAnonymous] = useState(settings.anonymousUploads);
    const [saveNote, setSaveNote] = useState<string | null>(null);
    const [check, setCheck] = useState<Check>({ kind: 'idle' });

    const normalized = normalizeServerUrl(serverInput);
    const dirty = normalized !== settings.serverUrl || anonymous !== settings.anonymousUploads;

    const save = async () => {
        if (!normalized) return;
        try {
            await onSave({ serverUrl: normalized, anonymousUploads: anonymous });
            setSaveNote('Saved');
        } catch (err) {
            setSaveNote(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const test = async () => {
        if (!normalized) return;
        setCheck({ kind: 'checking' });
        try {
            const status = await checkServer(normalized);
            setCheck(
                status >= 500
                    ? { kind: 'error', message: `Server answered with HTTP ${status}.` }
                    : { kind: 'ok', message: `Server reachable (HTTP ${status}).` },
            );
        } catch (err) {
            setCheck({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
    };

    return (
        <View>
            <Text style={shared.screenTitle}>
                NODE<Text style={{ color: colors.accent }}>{'//'}</Text>SETTINGS
            </Text>
            <Text style={shared.screenSubtitle}>Server and account</Text>

            <View style={shared.card}>
                <Text style={shared.cardLabel}>SERVER URL</Text>
                <TextInput
                    style={shared.input}
                    value={serverInput}
                    onChangeText={(t) => {
                        setServerInput(t);
                        setSaveNote(null);
                        setCheck({ kind: 'idle' });
                    }}
                    placeholder="http://192.168.1.20:3001"
                    placeholderTextColor={colors.textFaint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="url"
                    inputMode="url"
                    accessibilityLabel="Server URL"
                />
                <Text style={styles.hint}>
                    {normalized
                        ? `Uploads go to ${normalized}/api/ingest. On a phone, use your computer's LAN address, not localhost.`
                        : 'Enter an http:// or https:// address.'}
                </Text>

                <View style={styles.row}>
                    <TouchableOpacity
                        style={[shared.secondaryButton, styles.flex, !normalized && shared.disabled]}
                        onPress={test}
                        disabled={!normalized || check.kind === 'checking'}
                        accessibilityRole="button"
                    >
                        {check.kind === 'checking' ? (
                            <ActivityIndicator color={colors.text} />
                        ) : (
                            <Text style={shared.secondaryButtonText}>Test connection</Text>
                        )}
                    </TouchableOpacity>
                </View>
                {check.kind === 'ok' ? <Text style={[styles.status, { color: colors.success }]}>{check.message}</Text> : null}
                {check.kind === 'error' ? <Text style={[styles.status, { color: colors.danger }]}>{check.message}</Text> : null}
            </View>

            <View style={shared.card}>
                <Text style={shared.cardLabel}>ACCOUNT</Text>
                <View style={styles.switchRow}>
                    <View style={styles.flex}>
                        <Text style={styles.switchLabel}>Anonymous uploads</Text>
                        <Text style={styles.hint}>
                            Upload without an account. Works while the server allows it (ALLOW_ANONYMOUS_UPLOADS is not
                            &quot;false&quot;). Anonymous files are not tied to your web account.
                        </Text>
                    </View>
                    <Switch
                        value={anonymous}
                        onValueChange={(v) => {
                            setAnonymous(v);
                            setSaveNote(null);
                        }}
                        trackColor={{ true: colors.accent, false: colors.border }}
                        accessibilityLabel="Anonymous uploads"
                    />
                </View>
                <AccountSection serverUrl={settings.serverUrl} signedIn={signedIn} />
            </View>

            <TouchableOpacity
                style={[shared.button, (!dirty || !normalized) && shared.disabled]}
                onPress={save}
                disabled={!dirty || !normalized}
                accessibilityRole="button"
            >
                <Text style={shared.buttonText}>SAVE</Text>
            </TouchableOpacity>
            {saveNote ? <Text style={styles.status}>{saveNote}</Text> : null}
        </View>
    );
}

/** Sign-in (POST /api/mobile/token) / sign-out (revokes the refresh token on the server). */
function AccountSection({ serverUrl, signedIn }: { serverUrl: string; signedIn: boolean }) {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

    if (!secureStoreAvailable) {
        return <Text style={styles.hint}>Sign-in is available in the iOS and Android app (tokens are kept in the device keychain).</Text>;
    }

    if (signedIn) {
        return (
            <View style={styles.accountBox}>
                <Text style={[styles.status, { color: colors.success }]}>Signed in to {serverUrl}. Uploads are saved to your account.</Text>
                <TouchableOpacity
                    style={[shared.secondaryButton, styles.signOut, busy && shared.disabled]}
                    disabled={busy}
                    onPress={async () => {
                        setBusy(true);
                        await signOut();
                        setBusy(false);
                        setMessage(null);
                    }}
                    accessibilityRole="button"
                >
                    {busy ? <ActivityIndicator color={colors.text} /> : <Text style={[shared.secondaryButtonText, { color: colors.danger }]}>Sign out</Text>}
                </TouchableOpacity>
            </View>
        );
    }

    const canSubmit = email.trim().length > 3 && password.length > 0 && !busy;
    const submit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setMessage(null);
        try {
            await signIn(serverUrl, email, password);
            setPassword('');
            setMessage({ kind: 'ok', text: 'Signed in.' });
        } catch (err) {
            setMessage({ kind: 'error', text: err instanceof AuthError || err instanceof Error ? err.message : String(err) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <View style={styles.accountBox}>
            <Text style={styles.switchLabel}>Sign in</Text>
            <TextInput
                style={[shared.input, styles.field]}
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="email"
                keyboardType="email-address"
                inputMode="email"
                textContentType="username"
                accessibilityLabel="Email"
            />
            <TextInput
                style={[shared.input, styles.field]}
                value={password}
                onChangeText={setPassword}
                placeholder="Password"
                placeholderTextColor={colors.textFaint}
                secureTextEntry
                autoComplete="password"
                textContentType="password"
                onSubmitEditing={submit}
                accessibilityLabel="Password"
            />
            <TouchableOpacity style={[shared.button, styles.field, !canSubmit && shared.disabled]} onPress={submit} disabled={!canSubmit} accessibilityRole="button">
                {busy ? <ActivityIndicator color="#000" /> : <Text style={shared.buttonText}>SIGN IN</Text>}
            </TouchableOpacity>
            <Text style={styles.hint}>Use the email and password of your web account on {serverUrl}. Create accounts on the website.</Text>
            {message ? <Text style={[styles.status, { color: message.kind === 'ok' ? colors.success : colors.danger }]}>{message.text}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    accountBox: {
        marginTop: 16,
        borderTopWidth: 1,
        borderColor: colors.border,
        paddingTop: 16,
    },
    field: {
        marginTop: 10,
    },
    signOut: {
        marginTop: 12,
    },
    row: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 12,
    },
    flex: {
        flex: 1,
    },
    hint: {
        color: colors.textMuted,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 8,
    },
    status: {
        color: colors.textMuted,
        fontSize: 13,
        marginTop: 10,
    },
    switchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
    },
    switchLabel: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
});
