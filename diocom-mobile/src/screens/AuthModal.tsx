import { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { AuthError, signIn, signUp } from '../auth/session';
import { colors, radius, space, type } from '../theme';
import {
    Button,
    Card,
    haptic,
    Icon,
    Notice,
    SegmentedControl,
    TextField,
    useToast,
} from '../ui';

interface AuthModalProps {
    visible: boolean;
    serverUrl: string;
    onClose: () => void;
    onSuccess?: () => void;
}

export function AuthModal({ visible, serverUrl, onClose, onSuccess }: AuthModalProps) {
    const toast = useToast();
    const [mode, setMode] = useState<'signin' | 'signup'>('signin');
    const [username, setUsername] = useState('');
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const reset = () => {
        setUsername('');
        setEmail('');
        setPassword('');
        setConfirmPassword('');
        setErrorMsg(null);
        setBusy(false);
    };

    const handleClose = () => {
        reset();
        onClose();
    };

    const isSignUp = mode === 'signup';
    const canSubmit =
        email.trim().length > 3 &&
        password.length >= 8 &&
        (!isSignUp || (password === confirmPassword && username.trim().length >= 3)) &&
        !busy;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        haptic.light();
        setBusy(true);
        setErrorMsg(null);

        if (isSignUp) {
            const cleanUser = username.trim().toLowerCase();
            if (cleanUser.length < 3 || cleanUser.length > 30 || !/^[a-z0-9_]+$/.test(cleanUser)) {
                setErrorMsg('Username must be 3-30 letters, numbers, or underscores.');
                setBusy(false);
                return;
            }
            if (password !== confirmPassword) {
                setErrorMsg('Passwords do not match');
                setBusy(false);
                return;
            }
        }

        try {
            if (isSignUp) {
                await signUp(serverUrl, email.trim(), password, username.trim().toLowerCase());
                haptic.success();
                toast.show(`Account @${username.trim().toLowerCase()} created successfully!`);
            } else {
                await signIn(serverUrl, email.trim(), password);
                haptic.success();
                toast.show('Welcome back!');
            }
            handleClose();
            onSuccess?.();
        } catch (err) {
            haptic.error();
            setErrorMsg(err instanceof AuthError || err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            visible={visible}
            animationType="slide"
            transparent
            onRequestClose={handleClose}
        >
            <View style={styles.backdrop}>
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />

                <View style={styles.sheet}>
                    {/* Header */}
                    <View style={styles.sheetHeader}>
                        <View style={styles.brandBadge}>
                            <Icon name="flash" size={18} color={colors.primary} />
                        </View>
                        <Text style={styles.title}>
                            {isSignUp ? 'Create an Account' : 'Welcome to Datran'}
                        </Text>
                        <Text style={styles.subtitle}>
                            {isSignUp
                                ? 'Unlock 50 GB transfers and persistent cloud vault'
                                : 'Sign in to access your vault and manage active links'}
                        </Text>
                        <Pressable
                            style={styles.closeBtn}
                            onPress={handleClose}
                            accessibilityRole="button"
                            accessibilityLabel="Close"
                        >
                            <Icon name="close" size={20} color={colors.textMuted} />
                        </Pressable>
                    </View>

                    {/* Mode selector */}
                    <View style={styles.modeWrap}>
                        <SegmentedControl
                            value={mode}
                            onChange={(val) => {
                                setMode(val as 'signin' | 'signup');
                                setErrorMsg(null);
                            }}
                            segments={[
                                { key: 'signin', label: 'Sign In' },
                                { key: 'signup', label: 'Create Account' },
                            ]}
                        />
                    </View>

                    {/* Form fields */}
                    <View style={styles.form}>
                        {isSignUp ? (
                            <TextField
                                label="USERNAME (@handle)"
                                value={username}
                                onChangeText={(t) => {
                                    setUsername(t.toLowerCase().replace(/[^a-z0-9_]/g, ''));
                                    setErrorMsg(null);
                                }}
                                placeholder="alex_99"
                                icon="person-outline"
                                autoCapitalize="none"
                                autoCorrect={false}
                                autoComplete="username"
                                hint="Your unique handle for receiving files directly."
                            />
                        ) : null}

                        <TextField
                            label="EMAIL"
                            value={email}
                            onChangeText={(t) => {
                                setEmail(t);
                                setErrorMsg(null);
                            }}
                            placeholder="name@company.com"
                            icon="mail-outline"
                            autoCapitalize="none"
                            autoCorrect={false}
                            autoComplete="email"
                            keyboardType="email-address"
                            inputMode="email"
                        />

                        <TextField
                            label="PASSWORD"
                            value={password}
                            onChangeText={(t) => {
                                setPassword(t);
                                setErrorMsg(null);
                            }}
                            placeholder={isSignUp ? 'At least 8 characters' : 'Enter password'}
                            icon="lock-closed-outline"
                            secureTextEntry
                            revealable
                            autoComplete={isSignUp ? 'new-password' : 'password'}
                            onSubmitEditing={isSignUp ? undefined : handleSubmit}
                        />

                        {isSignUp ? (
                            <TextField
                                label="CONFIRM PASSWORD"
                                value={confirmPassword}
                                onChangeText={(t) => {
                                    setConfirmPassword(t);
                                    setErrorMsg(null);
                                }}
                                placeholder="Re-enter password"
                                icon="lock-closed-outline"
                                secureTextEntry
                                revealable
                                autoComplete="new-password"
                                onSubmitEditing={handleSubmit}
                            />
                        ) : null}

                        {errorMsg ? (
                            <View style={styles.errorNotice}>
                                <Notice tone="danger" message={errorMsg} />
                            </View>
                        ) : null}

                        <Button
                            label={isSignUp ? 'Create Account' : 'Sign In'}
                            icon={isSignUp ? 'person-add-outline' : 'log-in-outline'}
                            variant="primary"
                            size="lg"
                            fullWidth
                            disabled={!canSubmit}
                            loading={busy}
                            onPress={handleSubmit}
                        />

                        <Text style={styles.termsNotice}>
                            By continuing, you agree to Datran's zero-knowledge security policy and terms of service.
                        </Text>
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.75)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        padding: space.xl,
        paddingBottom: space.xxxl,
        gap: space.lg,
        maxHeight: '90%',
    },
    sheetHeader: {
        alignItems: 'center',
        gap: 6,
        paddingTop: space.xs,
        position: 'relative',
    },
    brandBadge: {
        width: 36,
        height: 36,
        borderRadius: 12,
        backgroundColor: colors.primarySoft,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 4,
    },
    title: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '800',
        letterSpacing: 0.2,
    },
    subtitle: {
        color: colors.textMuted,
        fontSize: 13,
        textAlign: 'center',
        maxWidth: 300,
    },
    closeBtn: {
        position: 'absolute',
        top: 0,
        right: 0,
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
    },
    modeWrap: {
        marginTop: space.xs,
    },
    form: {
        gap: space.sm,
    },
    errorNotice: {
        marginVertical: space.xs,
    },
    termsNotice: {
        color: colors.textFaint,
        fontSize: 11,
        textAlign: 'center',
        lineHeight: 16,
        marginTop: space.xs,
    },
});
