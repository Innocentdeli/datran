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

interface SpacesModalProps {
    visible: boolean;
    serverUrl: string;
    signedIn: boolean;
    onClose: () => void;
    onOpenAuth?: () => void;
    onSelectFile?: (file: { name: string; link: string; size: number }) => void;
}

export function SpacesModal({
    visible,
    serverUrl,
    signedIn,
    onClose,
    onOpenAuth,
    onSelectFile,
}: SpacesModalProps) {
    const toast = useToast();
    const [tab, setTab] = useState<'owned' | 'member'>('owned');
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
        if (visible && signedIn) {
            loadSpaces();
        }
    }, [visible, signedIn, loadSpaces]);

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
            const res = await createNewSpace(serverUrl, {
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
                expiresInHours: 720, // 30 days for space files
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

    const handleClose = () => {
        setSelectedSpace(null);
        setShowCreate(false);
        setErrorMsg(null);
        onClose();
    };

    const displayedSpaces = tab === 'owned' ? ownedSpaces : memberSpaces;

    return (
        <Modal visible={visible} transparent animationType="slide" onRequestClose={handleClose}>
            <View style={styles.backdrop}>
                <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
                <View style={styles.sheet}>
                    {/* Header */}
                    <View style={styles.header}>
                        <View style={styles.iconWrap}>
                            <Icon name="folder-open" size={24} color={colors.primary} />
                        </View>
                        <Text style={styles.title}>
                            {selectedSpace ? selectedSpace.name : 'Shared Spaces'}
                        </Text>
                        <Text style={styles.subtitle} numberOfLines={1}>
                            {selectedSpace
                                ? selectedSpace.description || `${selectedSpace.is_public ? 'Public' : 'Private'} Collaborative Space`
                                : 'Persistent shared folders for team projects and clients'}
                        </Text>
                        <Pressable style={styles.closeBtn} onPress={selectedSpace ? () => setSelectedSpace(null) : handleClose}>
                            <Icon name={selectedSpace ? 'arrow-back' : 'close'} size={20} color={colors.textMuted} />
                        </Pressable>
                    </View>

                    {!signedIn ? (
                        <View style={styles.authPrompt}>
                            <EmptyState
                                icon="lock-closed-outline"
                                title="Sign In Required"
                                message="Shared Spaces are persistent team workspaces linked to your Datran account."
                                action={
                                    <Button
                                        label="Sign In to Datran"
                                        variant="primary"
                                        size="md"
                                        onPress={() => {
                                            handleClose();
                                            onOpenAuth?.();
                                        }}
                                    />
                                }
                            />
                        </View>
                    ) : selectedSpace ? (
                        /* DETAIL VIEW OF SELECTED SPACE */
                        <View style={styles.detailContainer}>
                            <View style={styles.spaceMetaRow}>
                                <Badge
                                    label={selectedSpace.is_public ? 'Public Link' : 'Invite Only'}
                                    tone={selectedSpace.is_public ? 'primary' : 'neutral'}
                                    icon={selectedSpace.is_public ? 'globe-outline' : 'lock-closed-outline'}
                                />
                                <Badge
                                    label={`${spaceMembers.length} Member${spaceMembers.length === 1 ? '' : 's'}`}
                                    tone="violet"
                                    icon="people-outline"
                                />
                                <IconButton
                                    icon="link-outline"
                                    label="Copy space link"
                                    size={30}
                                    onPress={() => copySpaceLink(selectedSpace.slug)}
                                />
                            </View>

                            <Text style={styles.sectionTitle}>Files in Space ({spaceFiles.length})</Text>

                            {detailLoading ? (
                                <ActivityIndicator color={colors.primary} style={{ marginVertical: space.xl }} />
                            ) : (
                                <ScrollView style={styles.filesScroll} showsVerticalScrollIndicator={false}>
                                    {spaceFiles.length === 0 ? (
                                        <View style={styles.emptyDetail}>
                                            <Icon name="cloud-upload-outline" size={32} color={colors.textFaint} />
                                            <Text style={styles.emptyDetailText}>No files in this space yet.</Text>
                                        </View>
                                    ) : (
                                        spaceFiles.map((file, idx) => (
                                            <Pressable
                                                key={idx}
                                                onPress={() => {
                                                    onSelectFile?.({
                                                        name: file.original_name,
                                                        link: `${serverUrl.replace(/\/+$/, '')}/v1/${file.share_id}`,
                                                        size: file.file_size,
                                                    });
                                                }}
                                                style={({ pressed }) => [styles.fileRow, pressed && styles.fileRowPressed]}
                                            >
                                                <FileIcon name={file.original_name} mime={file.mime_type} size={36} />
                                                <View style={styles.fileInfo}>
                                                    <Text style={styles.fileName} numberOfLines={1}>{file.original_name}</Text>
                                                    <Text style={styles.fileMetaText}>
                                                        {formatBytes(file.file_size)} · by {file.uploader_name}
                                                    </Text>
                                                </View>
                                                <Icon name="arrow-forward-outline" size={16} color={colors.textFaint} />
                                            </Pressable>
                                        ))
                                    )}
                                </ScrollView>
                            )}

                            <Button
                                label={uploadingToSpace ? 'Uploading File...' : '+ Upload File to Space'}
                                icon="cloud-upload-outline"
                                variant="primary"
                                size="lg"
                                fullWidth
                                loading={uploadingToSpace}
                                onPress={handleUploadToSpace}
                            />
                        </View>
                    ) : showCreate ? (
                        /* CREATE SPACE FORM */
                        <View style={styles.createForm}>
                            <TextField
                                label="SPACE NAME"
                                value={newName}
                                onChangeText={setNewName}
                                placeholder="e.g. Design System 2026"
                                autoFocus
                            />
                            <TextField
                                label="DESCRIPTION (OPTIONAL)"
                                value={newDesc}
                                onChangeText={setNewDesc}
                                placeholder="What is this space for?"
                            />

                            <View style={styles.switchRow}>
                                <View style={styles.switchInfo}>
                                    <Text style={styles.switchTitle}>Public Access Link</Text>
                                    <Text style={styles.switchSubtitle}>Anyone with the space URL can view and download</Text>
                                </View>
                                <Switch
                                    value={newIsPublic}
                                    onValueChange={(val) => {
                                        haptic.tap();
                                        setNewIsPublic(val);
                                    }}
                                    trackColor={{ true: colors.primary, false: colors.surfacePressed }}
                                    thumbColor={colors.text}
                                />
                            </View>

                            <View style={styles.formBtnRow}>
                                <Button
                                    label="Cancel"
                                    variant="ghost"
                                    size="md"
                                    onPress={() => setShowCreate(false)}
                                />
                                <Button
                                    label="Create Space"
                                    icon="checkmark-outline"
                                    variant="primary"
                                    size="md"
                                    disabled={!newName.trim()}
                                    loading={creating}
                                    onPress={handleCreateSpace}
                                />
                            </View>
                        </View>
                    ) : (
                        /* SPACES LIST */
                        <View style={styles.listContainer}>
                            <View style={styles.segmentedRow}>
                                <SegmentedControl
                                    value={tab}
                                    onChange={(v) => setTab(v)}
                                    segments={[
                                        { key: 'owned', label: 'My Spaces', count: ownedSpaces.length },
                                        { key: 'member', label: 'Joined', count: memberSpaces.length },
                                    ]}
                                />
                                <Button
                                    label="+ New Space"
                                    variant="tonal"
                                    size="sm"
                                    onPress={() => setShowCreate(true)}
                                />
                            </View>

                            {loading ? (
                                <ActivityIndicator color={colors.primary} style={{ marginVertical: space.xxl }} />
                            ) : (
                                <ScrollView style={styles.spacesScroll} showsVerticalScrollIndicator={false}>
                                    {displayedSpaces.length === 0 ? (
                                        <EmptyState
                                            icon="folder-open-outline"
                                            title={tab === 'owned' ? 'No Spaces Created' : 'No Joined Spaces'}
                                            message={
                                                tab === 'owned'
                                                    ? 'Create a persistent shared space to collaborate on team files.'
                                                    : 'Spaces shared with you by other Datran users will appear here.'
                                            }
                                        />
                                    ) : (
                                        displayedSpaces.map((sp) => (
                                            <Pressable
                                                key={sp.id}
                                                onPress={() => loadSpaceDetail(sp)}
                                                style={({ pressed }) => [styles.spaceCard, pressed && styles.spaceCardPressed]}
                                            >
                                                <View style={styles.spaceCardIcon}>
                                                    <Icon name="folder" size={24} color={colors.primary} />
                                                </View>
                                                <View style={styles.spaceCardBody}>
                                                    <Text style={styles.spaceCardName}>{sp.name}</Text>
                                                    <Text style={styles.spaceCardDesc} numberOfLines={1}>
                                                        {sp.description || `${sp.is_public ? 'Public' : 'Private'} space`}
                                                    </Text>
                                                </View>
                                                <Icon name="chevron-forward" size={18} color={colors.textFaint} />
                                            </Pressable>
                                        ))
                                    )}
                                </ScrollView>
                            )}
                        </View>
                    )}
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
        maxHeight: '90%',
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
    authPrompt: {
        paddingVertical: space.xl,
    },
    listContainer: {
        gap: space.md,
    },
    segmentedRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
    },
    spacesScroll: {
        maxHeight: 320,
    },
    spaceCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: space.lg,
        marginBottom: space.sm,
    },
    spaceCardPressed: {
        backgroundColor: colors.surfacePressed,
    },
    spaceCardIcon: {
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    spaceCardBody: {
        flex: 1,
        minWidth: 0,
    },
    spaceCardName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    spaceCardDesc: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 2,
    },
    createForm: {
        gap: space.lg,
    },
    switchRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.lg,
        padding: space.lg,
        borderWidth: 1,
        borderColor: colors.border,
    },
    switchInfo: {
        flex: 1,
        marginRight: space.md,
    },
    switchTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    switchSubtitle: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 2,
    },
    formBtnRow: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        gap: space.md,
    },
    detailContainer: {
        gap: space.md,
    },
    spaceMetaRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    sectionTitle: {
        color: colors.textMuted,
        fontSize: 12,
        fontWeight: '700',
        letterSpacing: 0.8,
        marginTop: space.xs,
    },
    filesScroll: {
        maxHeight: 220,
        minHeight: 100,
    },
    emptyDetail: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: space.xl,
        gap: space.xs,
    },
    emptyDetailText: {
        color: colors.textFaint,
        fontSize: 13,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.sm,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: colors.border,
    },
    fileRowPressed: {
        backgroundColor: colors.surfacePressed,
    },
    fileInfo: {
        flex: 1,
        minWidth: 0,
    },
    fileName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    fileMetaText: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 2,
    },
});
