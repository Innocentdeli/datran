import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';

import {
    searchHandles,
    sendFileToHandle,
    type UserHandleResult,
} from '../api/client';
import { recordPeerTransfer } from '../storage/savedPeers';
import { colors, radius, space } from '../theme';
import {
    Badge,
    Button,
    Card,
    haptic,
    Icon,
    IconButton,
    Notice,
    TextField,
    useToast,
} from '../ui';

interface UserPushModalProps {
    visible: boolean;
    serverUrl: string;
    shareId: string;
    filename: string;
    onClose: () => void;
    onSuccess?: () => void;
}

export function UserPushModal({
    visible,
    serverUrl,
    shareId,
    filename,
    onClose,
    onSuccess,
}: UserPushModalProps) {
    const toast = useToast();
    const [query, setQuery] = useState('');
    const [results, setResults] = useState<UserHandleResult[]>([]);
    const [selectedUser, setSelectedUser] = useState<UserHandleResult | null>(null);
    const [message, setMessage] = useState('');
    const [searching, setSearching] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    // Search handles with debounce
    useEffect(() => {
        if (!query.trim()) {
            setResults([]);
            return;
        }
        let alive = true;
        setSearching(true);
        const timer = setTimeout(async () => {
            try {
                const users = await searchHandles(serverUrl, query);
                if (alive) setResults(users);
            } catch {
                if (alive) setResults([]);
            } finally {
                if (alive) setSearching(false);
            }
        }, 300);

        return () => {
            alive = false;
            clearTimeout(timer);
        };
    }, [query, serverUrl]);

    const handleSelectUser = (user: UserHandleResult) => {
        haptic.light();
        setSelectedUser(user);
        setErrorMsg(null);
    };

    const handleSend = async () => {
        if (!selectedUser) return;
        haptic.medium();
        setSubmitting(true);
        setErrorMsg(null);

        try {
            await sendFileToHandle(serverUrl, selectedUser.username, shareId, message);
            await recordPeerTransfer({
                id: selectedUser.id,
                name: selectedUser.name || `@${selectedUser.username}`,
                username: selectedUser.username,
                type: 'user',
                serverUrl,
            });
            haptic.success();
            toast.show(`Sent "${filename}" directly to @${selectedUser.username}!`);
            onSuccess?.();
            handleClose();
        } catch (err) {
            haptic.error();
            setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setSubmitting(false);
        }
    };

    const handleClose = () => {
        setQuery('');
        setResults([]);
        setSelectedUser(null);
        setMessage('');
        setErrorMsg(null);
        setSubmitting(false);
        onClose();
    };

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
            <View style={styles.backdrop}>
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                <View style={styles.sheet}>
                    {/* Header */}
                    <View style={styles.header}>
                        <View style={styles.iconWrap}>
                            <Icon name="paper-plane" size={24} color={colors.primary} />
                        </View>
                        <Text style={styles.title}>Send to User Vault</Text>
                        <Text style={styles.subtitle} numberOfLines={1}>
                            Deliver &ldquo;{filename}&rdquo; directly to another user&rsquo;s account
                        </Text>
                        <Pressable style={styles.closeBtn} onPress={handleClose}>
                            <Icon name="close" size={20} color={colors.textMuted} />
                        </Pressable>
                    </View>

                    {errorMsg ? (
                        <View style={styles.errorWrap}>
                            <Notice tone="danger" message={errorMsg} />
                        </View>
                    ) : null}

                    {/* RECIPIENT SEARCH / SELECTION */}
                    {selectedUser ? (
                        <View style={styles.selectedUserCard}>
                            <View style={styles.avatar}>
                                <Icon name="person" size={20} color={colors.primary} />
                            </View>
                            <View style={styles.userInfo}>
                                <Text style={styles.userName}>{selectedUser.name}</Text>
                                <Text style={styles.userHandle}>@{selectedUser.username}</Text>
                            </View>
                            <IconButton
                                icon="close"
                                label="Change recipient"
                                size={28}
                                onPress={() => setSelectedUser(null)}
                            />
                        </View>
                    ) : (
                        <View style={styles.searchBlock}>
                            <TextField
                                label="FIND RECIPIENT"
                                value={query}
                                onChangeText={(t) => {
                                    setQuery(t);
                                    setErrorMsg(null);
                                }}
                                placeholder="Search by @username"
                                icon="at-outline"
                                autoCapitalize="none"
                                autoCorrect={false}
                                hint="Type a username to deposit the file into their personal vault."
                            />

                            {searching ? (
                                <View style={styles.searchingRow}>
                                    <ActivityIndicator size="small" color={colors.primary} />
                                    <Text style={styles.searchingText}>Searching users...</Text>
                                </View>
                            ) : null}

                            {results.length > 0 ? (
                                <ScrollView style={styles.resultsList} keyboardShouldPersistTaps="handled">
                                    {results.map((u) => (
                                        <Pressable
                                            key={u.id}
                                            onPress={() => handleSelectUser(u)}
                                            style={({ pressed }) => [
                                                styles.userResultRow,
                                                pressed && styles.userResultRowPressed,
                                            ]}
                                        >
                                            <View style={styles.resultAvatar}>
                                                <Icon name="person" size={16} color={colors.textMuted} />
                                            </View>
                                            <View style={styles.resultMeta}>
                                                <Text style={styles.resultName}>{u.name}</Text>
                                                <Text style={styles.resultHandle}>@{u.username}</Text>
                                            </View>
                                            <Icon name="chevron-forward" size={16} color={colors.textFaint} />
                                        </Pressable>
                                    ))}
                                </ScrollView>
                            ) : query.trim().length > 1 && !searching ? (
                                <Text style={styles.noResultsText}>No user found matching &ldquo;{query}&rdquo;</Text>
                            ) : null}
                        </View>
                    )}

                    {/* OPTIONAL MESSAGE INPUT */}
                    {selectedUser ? (
                        <View style={styles.messageBlock}>
                            <TextField
                                label="MESSAGE (OPTIONAL)"
                                value={message}
                                onChangeText={setMessage}
                                placeholder="Add a note for the recipient..."
                                maxLength={500}
                                multiline
                            />

                            <Button
                                label={`Send to @${selectedUser.username}`}
                                icon="paper-plane"
                                variant="primary"
                                size="lg"
                                fullWidth
                                loading={submitting}
                                onPress={handleSend}
                            />
                        </View>
                    ) : null}
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.8)',
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
    },
    header: {
        alignItems: 'center',
        gap: 6,
        position: 'relative',
    },
    iconWrap: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 4,
    },
    title: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '800',
    },
    subtitle: {
        color: colors.textMuted,
        fontSize: 13,
        textAlign: 'center',
        maxWidth: 320,
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
    errorWrap: {
        marginVertical: space.xs,
    },
    searchBlock: {
        gap: space.sm,
    },
    searchingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 4,
    },
    searchingText: {
        color: colors.textMuted,
        fontSize: 12,
    },
    resultsList: {
        maxHeight: 180,
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        marginTop: 4,
    },
    userResultRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
    },
    userResultRowPressed: {
        backgroundColor: colors.surfacePressed,
    },
    resultAvatar: {
        width: 32,
        height: 32,
        borderRadius: 16,
        backgroundColor: colors.surfacePressed,
        alignItems: 'center',
        justifyContent: 'center',
    },
    resultMeta: {
        flex: 1,
        minWidth: 0,
    },
    resultName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    resultHandle: {
        color: colors.textFaint,
        fontSize: 12,
    },
    noResultsText: {
        color: colors.textFaint,
        fontSize: 12,
        textAlign: 'center',
        paddingVertical: space.sm,
    },
    selectedUserCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        padding: space.lg,
    },
    avatar: {
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    userInfo: {
        flex: 1,
        minWidth: 0,
    },
    userName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    userHandle: {
        color: colors.primary,
        fontSize: 13,
        fontWeight: '600',
    },
    messageBlock: {
        gap: space.lg,
    },
});
