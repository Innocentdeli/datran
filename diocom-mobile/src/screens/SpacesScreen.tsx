import { useCallback, useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Alert,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Switch,
    Text,
    View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';

import {
    addFileToSpace,
    createNewSpace,
    fetchSpaceDetail,
    fetchSpacesList,
    uploadDocument,
    type SpaceFile,
    type SpaceItem,
    type SpaceMember,
} from '../api/client';
import { colors, formatBytes, formatRelativeTime, radius, space } from '../theme';
import {
    Badge,
    Button,
    Card,
    EmptyState,
    FileIcon,
    haptic,
    Icon,
    IconButton,
    Notice,
    SegmentedControl,
    TextField,
    useToast,
} from '../ui';
import { FileRequestsScreen } from './FileRequestsScreen';

interface SpacesScreenProps {
    serverUrl: string;
    signedIn: boolean;
    onOpenAuth: () => void;
    onOpenSpacesModal?: () => void;
}

export function SpacesScreen({
    serverUrl,
    signedIn,
    onOpenAuth,
}: SpacesScreenProps) {
    const toast = useToast();
    const [subTab, setSubTab] = useState<'spaces' | 'requests'>('spaces');
    const [spacesTab, setSpacesTab] = useState<'owned' | 'member'>('owned');

    // Spaces state
    const [ownedSpaces, setOwnedSpaces] = useState<SpaceItem[]>([]);
    const [memberSpaces, setMemberSpaces] = useState<SpaceItem[]>([]);
    const [loading, setLoading] = useState(false);
    const [selectedSpace, setSelectedSpace] = useState<SpaceItem | null>(null);

    // Detail view state
    const [spaceMembers, setSpaceMembers] = useState<SpaceMember[]>([]);
    const [spaceFiles, setSpaceFiles] = useState<SpaceFile[]>([]);
    const [detailLoading, setDetailLoading] = useState(false);
    const [uploadingToSpace, setUploadingToSpace] = useState(false);

    // Create space modal form
    const [showCreate, setShowCreate] = useState(false);
    const [newName, setNewName] = useState('');
    const [newDesc, setNewDesc] = useState('');
    const [newIsPublic, setNewIsPublic] = useState(false);
    const [creating, setCreating] = useState(false);
    const [errorMsg, setErrorMsg] = useState<string | null>(null);

    const loadSpaces = useCallback(async () => {
        if (!signedIn) return;
        setLoading(true);
        setErrorMsg(null);
        try {
            const data = await fetchSpacesList(serverUrl);
            setOwnedSpaces(data.owned);
            setMemberSpaces(data.member);
        } catch (err) {
            setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [serverUrl, signedIn]);

    useEffect(() => {
        if (signedIn && subTab === 'spaces') {
            loadSpaces();
        }
    }, [signedIn, subTab, loadSpaces]);

    // Load space details
    const loadSpaceDetail = async (targetSpace: SpaceItem) => {
        setSelectedSpace(targetSpace);
        setDetailLoading(true);
        try {
            const detail = await fetchSpaceDetail(serverUrl, targetSpace.slug);
            setSpaceMembers(detail.members);
            setSpaceFiles(detail.files);
        } catch (err) {
            toast.show(`Could not load space: ${err instanceof Error ? err.message : String(err)}`, 'error');
        } finally {
            setDetailLoading(false);
        }
    };

    // Create Space
    const handleCreateSpace = async () => {
        if (!newName.trim()) return;
        haptic.medium();
        setCreating(true);
        try {
            await createNewSpace(serverUrl, {
                name: newName.trim(),
                description: newDesc.trim() || undefined,
                isPublic: newIsPublic,
            });
            haptic.success();
            toast.show(`Space "${newName.trim()}" created!`);
            setShowCreate(false);
            setNewName('');
            setNewDesc('');
            setNewIsPublic(false);
            await loadSpaces();
        } catch (err) {
            haptic.error();
            Alert.alert('Create Space Failed', err instanceof Error ? err.message : String(err));
        } finally {
            setCreating(false);
        }
    };

    // Upload file into space
    const handleUploadToSpace = async () => {
        if (!selectedSpace) return;
        haptic.light();
        try {
            const picked = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
            });
            if (picked.canceled || !picked.assets?.length) return;
            const asset = picked.assets[0];
            if (!asset) return;

            setUploadingToSpace(true);
            const res = await uploadDocument({
                serverUrl,
                asset,
                expiresInHours: 720,
            });

            const shareId = res.link.split('/').pop() || '';
            if (shareId) {
                await addFileToSpace(serverUrl, selectedSpace.slug, shareId);
                haptic.success();
                toast.show(`Added "${asset.name}" to space!`);
                await loadSpaceDetail(selectedSpace);
            }
        } catch (err) {
            haptic.error();
            Alert.alert('Space Upload Error', err instanceof Error ? err.message : String(err));
        } finally {
            setUploadingToSpace(false);
        }
    };

    const copySpaceLink = async (slug: string) => {
        const link = `${serverUrl.replace(/\/+$/, '')}/space/${slug}`;
        await Clipboard.setStringAsync(link);
        haptic.light();
        toast.show('Space link copied to clipboard!');
    };

    const displayedSpaces = spacesTab === 'owned' ? ownedSpaces : memberSpaces;

    return (
        <View style={styles.container}>
            {/* SEGMENTED SWITCHER (CLEAN & DIFFERENTIATED) */}
            <SegmentedControl
                segments={[
                    { key: 'spaces', label: 'Project Spaces' },
                    { key: 'requests', label: 'File Requests' },
                ]}
                value={subTab}
                onChange={(key) => {
                    haptic.light();
                    setSubTab(key as 'spaces' | 'requests');
                    setSelectedSpace(null);
                }}
            />

            {subTab === 'spaces' ? (
                <View style={styles.spacesSection}>
                    <View style={styles.headerBlock}>
                        <View style={styles.headerTop}>
                            <View style={styles.headerTitleWrap}>
                                <Text style={styles.screenTitle}>Shared Spaces</Text>
                                <Text style={styles.screenSubtitle}>
                                    Persistent collaborative folders for client deliverables & team vaults.
                                </Text>
                            </View>
                            {signedIn && !selectedSpace && (
                                <Button
                                    label="New Space"
                                    icon="add-circle-outline"
                                    variant="primary"
                                    size="sm"
                                    onPress={() => {
                                        haptic.tap();
                                        setShowCreate(true);
                                    }}
                                />
                            )}
                        </View>
                    </View>

                    {!signedIn ? (
                        <Notice
                            tone="info"
                            title="Sign in to Access Spaces"
                            message="Shared Spaces require an account to manage files, configure permissions, and collaborate with team members."
                            action={<Button label="Sign In" size="sm" variant="tonal" onPress={onOpenAuth} />}
                        />
                    ) : selectedSpace ? (
                        /* SPACE DETAIL VIEW */
                        <View style={styles.detailWrap}>
                            <View style={styles.detailHeader}>
                                <IconButton
                                    icon="arrow-back"
                                    label="Back to Spaces"
                                    size={36}
                                    onPress={() => setSelectedSpace(null)}
                                />
                                <View style={styles.detailHeaderInfo}>
                                    <Text style={styles.detailTitle}>{selectedSpace.name}</Text>
                                    <Text style={styles.detailSlug}>/space/{selectedSpace.slug}</Text>
                                </View>
                                <IconButton
                                    icon="copy-outline"
                                    label="Copy Link"
                                    size={36}
                                    onPress={() => copySpaceLink(selectedSpace.slug)}
                                />
                            </View>

                            <View style={styles.detailActionRow}>
                                <Button
                                    label="+ Add File to Space"
                                    icon="cloud-upload-outline"
                                    variant="primary"
                                    size="sm"
                                    loading={uploadingToSpace}
                                    onPress={handleUploadToSpace}
                                />
                            </View>

                            {detailLoading ? (
                                <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 20 }} />
                            ) : spaceFiles.length === 0 ? (
                                <EmptyState
                                    icon="folder-open-outline"
                                    title="No files yet"
                                    message="Upload client assets, renders, or project archives into this collaborative space."
                                    action={
                                        <Button
                                            label="Upload First File"
                                            icon="add"
                                            variant="primary"
                                            onPress={handleUploadToSpace}
                                        />
                                    }
                                />
                            ) : (
                                <View style={styles.fileList}>
                                    {spaceFiles.map((file) => (
                                        <Card key={file.share_id} style={styles.fileCard}>
                                            <FileIcon name={file.original_name} mime={file.mime_type} size={32} />
                                            <View style={styles.fileInfo}>
                                                <Text style={styles.fileName} numberOfLines={1}>
                                                    {file.original_name}
                                                </Text>
                                                <Text style={styles.fileMeta}>
                                                    {formatBytes(file.file_size)} · {formatRelativeTime(file.uploaded_at)}
                                                </Text>
                                            </View>
                                        </Card>
                                    ))}
                                </View>
                            )}
                        </View>
                    ) : (
                        /* SPACES LIST */
                        <View style={styles.listWrap}>
                            <SegmentedControl
                                segments={[
                                    { key: 'owned', label: `My Spaces (${ownedSpaces.length})` },
                                    { key: 'member', label: `Shared (${memberSpaces.length})` },
                                ]}
                                value={spacesTab}
                                onChange={(val) => setSpacesTab(val as 'owned' | 'member')}
                            />

                            {loading ? (
                                <ActivityIndicator size="small" color={colors.primary} style={{ marginTop: 24 }} />
                            ) : displayedSpaces.length === 0 ? (
                                <EmptyState
                                    icon="folder-outline"
                                    title={spacesTab === 'owned' ? 'No Spaces Created' : 'No Shared Spaces'}
                                    message={
                                        spacesTab === 'owned'
                                            ? 'Create a shared space to organize project deliverables with clients.'
                                            : 'Spaces shared with you will appear here.'
                                    }
                                    action={
                                        spacesTab === 'owned' ? (
                                            <Button
                                                label="Create a Space"
                                                icon="add"
                                                variant="primary"
                                                onPress={() => setShowCreate(true)}
                                            />
                                        ) : undefined
                                    }
                                />
                            ) : (
                                <View style={styles.spacesGrid}>
                                    {displayedSpaces.map((item) => (
                                        <Pressable
                                            key={item.id}
                                            style={({ pressed }) => [styles.spaceCard, pressed && styles.spaceCardPressed]}
                                            onPress={() => {
                                                haptic.tap();
                                                loadSpaceDetail(item);
                                            }}
                                        >
                                            <View style={styles.spaceCardTop}>
                                                <View style={styles.spaceIconWrap}>
                                                    <Icon name="folder" size={24} color={colors.primary} />
                                                </View>
                                                <Badge
                                                    label={item.is_public ? 'Public' : 'Private'}
                                                    tone={item.is_public ? 'success' : 'neutral'}
                                                />
                                            </View>
                                            <Text style={styles.spaceCardName} numberOfLines={1}>{item.name}</Text>
                                            <Text style={styles.spaceCardDesc} numberOfLines={2}>
                                                {item.description || 'No description'}
                                            </Text>
                                            <Text style={styles.spaceCardMeta}>
                                                Created {formatRelativeTime(item.created_at)}
                                            </Text>
                                        </Pressable>
                                    ))}
                                </View>
                            )}
                        </View>
                    )}
                </View>
            ) : (
                <FileRequestsScreen
                    serverUrl={serverUrl}
                    signedIn={signedIn}
                    onOpenAuth={onOpenAuth}
                />
            )}

            {/* CREATE SPACE MODAL */}
            <Modal visible={showCreate} transparent animationType="slide" onRequestClose={() => setShowCreate(false)}>
                <View style={styles.backdrop}>
                    <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowCreate(false)} />
                    <View style={styles.createSheet}>
                        <View style={styles.createHeader}>
                            <Text style={styles.createTitle}>Create Shared Space</Text>
                            <IconButton icon="close" label="Close" size={32} onPress={() => setShowCreate(false)} />
                        </View>
                        <TextField
                            label="SPACE NAME"
                            value={newName}
                            onChangeText={setNewName}
                            placeholder="e.g. Acme Client Portal, Brand Assets"
                        />
                        <TextField
                            label="DESCRIPTION (OPTIONAL)"
                            value={newDesc}
                            onChangeText={setNewDesc}
                            placeholder="Brief purpose of this space"
                        />
                        <View style={styles.switchRow}>
                            <View style={{ flex: 1 }}>
                                <Text style={styles.switchLabel}>Public Access</Text>
                                <Text style={styles.switchSub}>Anyone with the link can view assets</Text>
                            </View>
                            <Switch
                                value={newIsPublic}
                                onValueChange={setNewIsPublic}
                                trackColor={{ false: colors.border, true: colors.primary }}
                                thumbColor="#ffffff"
                            />
                        </View>
                        <Button
                            label="Create Space"
                            icon="folder-open-outline"
                            variant="primary"
                            size="lg"
                            fullWidth
                            loading={creating}
                            disabled={!newName.trim()}
                            onPress={handleCreateSpace}
                        />
                    </View>
                </View>
            </Modal>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        gap: space.lg,
    },
    spacesSection: {
        gap: space.md,
    },
    headerBlock: {
        gap: space.xs,
        paddingHorizontal: space.xs,
    },
    headerTop: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
    },
    headerTitleWrap: {
        flex: 1,
    },
    screenTitle: {
        color: colors.text,
        fontSize: 22,
        fontWeight: '800',
        letterSpacing: -0.3,
    },
    screenSubtitle: {
        color: colors.textMuted,
        fontSize: 13,
        lineHeight: 18,
    },
    listWrap: {
        gap: space.md,
    },
    spacesGrid: {
        gap: space.sm,
    },
    spaceCard: {
        padding: space.lg,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.lg,
        gap: space.xs,
    },
    spaceCardPressed: {
        backgroundColor: colors.surfacePressed,
    },
    spaceCardTop: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    spaceIconWrap: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    spaceCardName: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '700',
        marginTop: 4,
    },
    spaceCardDesc: {
        color: colors.textMuted,
        fontSize: 12,
        lineHeight: 16,
    },
    spaceCardMeta: {
        color: colors.textFaint,
        fontSize: 11,
        marginTop: 4,
    },
    detailWrap: {
        gap: space.md,
    },
    detailHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: space.xs,
    },
    detailHeaderInfo: {
        flex: 1,
    },
    detailTitle: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '800',
    },
    detailSlug: {
        color: colors.primary,
        fontSize: 12,
        fontFamily: 'monospace',
    },
    detailActionRow: {
        flexDirection: 'row',
        gap: space.sm,
    },
    fileList: {
        gap: space.xs,
    },
    fileCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        padding: space.md,
    },
    fileInfo: {
        flex: 1,
        gap: 2,
    },
    fileName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    fileMeta: {
        color: colors.textMuted,
        fontSize: 12,
    },
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.75)',
        justifyContent: 'flex-end',
    },
    createSheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        padding: space.xl,
        paddingBottom: space.xxxl,
        gap: space.lg,
    },
    createHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    createTitle: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '800',
    },
    switchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: space.xs,
    },
    switchLabel: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    switchSub: {
        color: colors.textMuted,
        fontSize: 12,
    },
});
