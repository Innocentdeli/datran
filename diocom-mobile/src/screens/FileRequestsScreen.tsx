import React, { useEffect, useState, useCallback } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { colors, formatBytes, radius, space, type } from '../theme';
import {
    Badge,
    Button,
    Card,
    EmptyState,
    IconButton,
    ScreenHeader,
    TextField,
    haptic,
    useToast,
} from '../ui';
import {
    fetchFileRequests,
    createFileRequest,
    toggleFileRequest,
    deleteFileRequest,
    type FileRequestItem,
} from '../api/client';

interface FileRequestsScreenProps {
    serverUrl: string;
    signedIn: boolean;
    onOpenAuth: () => void;
}

export function FileRequestsScreen({
    serverUrl,
    signedIn,
    onOpenAuth,
}: FileRequestsScreenProps) {
    const toast = useToast();
    const [requests, setRequests] = useState<FileRequestItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

    // Create form state
    const [title, setTitle] = useState('');
    const [description, setDescription] = useState('');
    const [customSlug, setCustomSlug] = useState('');
    const [password, setPassword] = useState('');
    const [creating, setCreating] = useState(false);

    const loadRequests = useCallback(async () => {
        if (!signedIn) return;
        setLoading(true);
        try {
            const data = await fetchFileRequests(serverUrl);
            setRequests(data);
        } catch (err: any) {
            toast.show(err.message || 'Failed to load file requests', 'error');
        } finally {
            setLoading(false);
        }
    }, [serverUrl, signedIn]);

    useEffect(() => {
        loadRequests();
    }, [loadRequests]);

    const handleCreate = async () => {
        if (!title.trim()) {
            toast.show('Please provide a title for the request', 'error');
            return;
        }

        setCreating(true);
        try {
            await createFileRequest(serverUrl, {
                title: title.trim(),
                description: description.trim() || undefined,
                customSlug: customSlug.trim() || undefined,
                password: password.trim() || undefined,
            });
            haptic.success();
            toast.show('File request link created!');
            setIsCreateModalOpen(false);
            setTitle('');
            setDescription('');
            setCustomSlug('');
            setPassword('');
            loadRequests();
        } catch (err: any) {
            haptic.error();
            toast.show(err.message || 'Failed to create request', 'error');
        } finally {
            setCreating(false);
        }
    };

    const handleCopy = async (req: FileRequestItem) => {
        haptic.light();
        const url = `${serverUrl.replace(/\/+$/, '')}/r/${req.slug}`;
        await Clipboard.setStringAsync(url);
        toast.show('Request link copied to clipboard!');
    };

    const handleToggle = async (req: FileRequestItem) => {
        haptic.tap();
        try {
            await toggleFileRequest(serverUrl, req.id, !req.is_active);
            setRequests((prev) =>
                prev.map((r) => (r.id === req.id ? { ...r, is_active: !r.is_active } : r))
            );
            toast.show(req.is_active ? 'Request paused' : 'Request activated');
        } catch (err: any) {
            toast.show(err.message || 'Action failed', 'error');
        }
    };

    const handleDelete = (req: FileRequestItem) => {
        Alert.alert(
            'Delete Request Link',
            `Are you sure you want to delete "${req.title}"? Clients will no longer be able to upload through this link.`,
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Delete',
                    style: 'destructive',
                    onPress: async () => {
                        try {
                            await deleteFileRequest(serverUrl, req.id);
                            haptic.success();
                            toast.show('Request deleted');
                            loadRequests();
                        } catch (err: any) {
                            toast.show(err.message || 'Delete failed', 'error');
                        }
                    },
                },
            ]
        );
    };

    if (!signedIn) {
        return (
            <View style={styles.container}>
                <EmptyState
                    icon="mail-unread-outline"
                    title="File Requests"
                    message="Create secure upload portals for clients and collaborators to send you large files directly. Sign in to start receiving files."
                    action={
                        <Button
                            label="Sign in to your account"
                            icon="log-in-outline"
                            variant="primary"
                            onPress={onOpenAuth}
                        />
                    }
                />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <View style={styles.topRow}>
                <View>
                    <Text style={styles.heading}>File Requests</Text>
                    <Text style={styles.subheading}>Collect files directly from clients</Text>
                </View>
                <Button
                    label="New Request"
                    icon="add-circle-outline"
                    variant="primary"
                    size="sm"
                    onPress={() => setIsCreateModalOpen(true)}
                />
            </View>

            {loading ? (
                <View style={styles.center}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            ) : requests.length === 0 ? (
                <EmptyState
                    icon="folder-open-outline"
                    title="No active requests"
                    message="Create a branded request link and share it with clients or team members to collect files effortlessly."
                    action={
                        <Button
                            label="Create your first request"
                            icon="add"
                            variant="primary"
                            onPress={() => setIsCreateModalOpen(true)}
                        />
                    }
                />
            ) : (
                <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
                    {requests.map((r) => {
                        const link = `${serverUrl.replace(/\/+$/, '')}/r/${r.slug}`;
                        return (
                            <Card key={r.id} style={styles.card}>
                                <View style={styles.cardHeader}>
                                    <View style={{ flex: 1, marginRight: space.sm }}>
                                        <Text style={styles.cardTitle}>{r.title}</Text>
                                        {r.description ? (
                                            <Text style={styles.cardDesc} numberOfLines={2}>
                                                {r.description}
                                            </Text>
                                        ) : null}
                                    </View>
                                    <Badge
                                        label={r.is_active ? 'ACTIVE' : 'PAUSED'}
                                        tone={r.is_active ? 'success' : 'neutral'}
                                    />
                                </View>

                                <View style={styles.linkBar}>
                                    <Text style={styles.linkText} numberOfLines={1} selectable>
                                        {link}
                                    </Text>
                                </View>

                                <View style={styles.metaRow}>
                                    <Text style={styles.metaText}>
                                        📥 {r.upload_count} file{r.upload_count === 1 ? '' : 's'} ({formatBytes(r.total_bytes)})
                                    </Text>
                                    {r.has_password && (
                                        <Badge label="Password" tone="warning" icon="lock-closed" />
                                    )}
                                </View>

                                <View style={styles.cardActions}>
                                    <Button
                                        label="Copy Link"
                                        icon="copy-outline"
                                        variant="secondary"
                                        size="sm"
                                        onPress={() => handleCopy(r)}
                                    />
                                    <Button
                                        label={r.is_active ? 'Pause' : 'Activate'}
                                        icon={r.is_active ? 'pause-outline' : 'play-outline'}
                                        variant="ghost"
                                        size="sm"
                                        onPress={() => handleToggle(r)}
                                    />
                                    <IconButton
                                        icon="trash-outline"
                                        label="Delete"
                                        size={36}
                                        onPress={() => handleDelete(r)}
                                    />
                                </View>
                            </Card>
                        );
                    })}
                </ScrollView>
            )}

            {/* CREATE REQUEST MODAL */}
            <Modal visible={isCreateModalOpen} animationType="slide" transparent onRequestClose={() => setIsCreateModalOpen(false)}>
                <View style={styles.backdrop}>
                    <View style={styles.sheet}>
                        <View style={styles.modalHeader}>
                            <Text style={styles.title}>New File Request</Text>
                            <IconButton icon="close-outline" label="Close" size={36} onPress={() => setIsCreateModalOpen(false)} />
                        </View>

                        <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
                            <TextField
                                label="REQUEST TITLE"
                                placeholder="e.g. Q3 Brand Photoshoots"
                                value={title}
                                onChangeText={setTitle}
                            />
                            <View style={{ height: space.md }} />

                            <TextField
                                label="CUSTOM LINK SLUG (OPTIONAL)"
                                placeholder="e.g. q3-photos"
                                value={customSlug}
                                onChangeText={setCustomSlug}
                                autoCapitalize="none"
                            />
                            <View style={{ height: space.md }} />

                            <TextField
                                label="INSTRUCTIONS FOR UPLOADER (OPTIONAL)"
                                placeholder="Please upload high-res RAW or ProRes files..."
                                value={description}
                                onChangeText={setDescription}
                                multiline
                                numberOfLines={3}
                            />
                            <View style={{ height: space.md }} />

                            <TextField
                                label="ACCESS PASSWORD (OPTIONAL)"
                                placeholder="Require password to upload"
                                value={password}
                                onChangeText={setPassword}
                                secureTextEntry
                                revealable
                            />
                            <View style={{ height: space.lg }} />

                            <Button
                                label={creating ? 'Creating...' : 'Create Request Link'}
                                icon="checkmark-circle-outline"
                                variant="primary"
                                size="lg"
                                fullWidth
                                disabled={creating}
                                onPress={handleCreate}
                            />
                        </ScrollView>
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        paddingHorizontal: space.md,
    },
    topRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: space.lg,
    },
    heading: {
        ...type.title,
        color: colors.text,
    },
    subheading: {
        ...type.caption,
        color: colors.textMuted,
        marginTop: 2,
    },
    center: {
        paddingVertical: space.xl * 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    list: {
        gap: space.md,
        paddingBottom: space.xl,
    },
    card: {
        padding: space.md,
    },
    cardHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        marginBottom: space.sm,
    },
    cardTitle: {
        ...type.headline,
        color: colors.text,
    },
    cardDesc: {
        ...type.body,
        color: colors.textMuted,
        marginTop: 2,
    },
    linkBar: {
        backgroundColor: colors.background,
        borderRadius: radius.sm,
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        borderWidth: 1,
        borderColor: colors.border,
        marginVertical: space.sm,
    },
    linkText: {
        fontFamily: 'monospace',
        fontSize: 12,
        color: colors.primary,
    },
    metaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: space.md,
    },
    metaText: {
        ...type.caption,
        color: colors.textMuted,
    },
    cardActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        borderTopWidth: 1,
        borderTopColor: colors.border,
        paddingTop: space.sm,
    },
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.75)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: radius.xl,
        borderTopRightRadius: radius.xl,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        maxHeight: '90%',
        paddingBottom: space.xl,
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
    },
    title: {
        ...type.headline,
        color: colors.text,
    },
    content: {
        padding: space.lg,
    },
});
