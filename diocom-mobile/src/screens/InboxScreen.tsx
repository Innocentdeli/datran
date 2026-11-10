import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Linking, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { fetchInboxTransfers, fetchMyFiles, respondToInboxTransfer, type InboxItem, type RemoteFile } from '../api/client';
import { LinkActions } from '../components/LinkActions';
import { MediaPreviewModal } from './MediaPreviewModal';
import { autoSaveFile } from '../storage/autoSave';
import type { HistoryItem } from '../storage/history';
import { recordPeerTransfer } from '../storage/savedPeers';
import { colors, formatBytes, formatExpiry, formatRelativeTime, radius, space, type } from '../theme';
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
    ScreenHeader,
    SegmentedControl,
    useToast,
} from '../ui';

interface InboxScreenProps {
    items: HistoryItem[];
    onRemove: (id: string) => void;
    onClear: () => void;
    signedIn: boolean;
    serverUrl: string;
    onUploadPress?: () => void;
    onSettingsPress?: () => void;
    onOpenAuth?: () => void;
    onOpenLobby?: () => void;
    onOpenSpaces?: () => void;
    onOpenPair?: () => void;
    onAddHistoryItem?: (item: HistoryItem) => void;
}

type Remote = { kind: 'idle' } | { kind: 'loading' } | { kind: 'ok'; files: RemoteFile[] } | { kind: 'error'; message: string };

interface DetailItem {
    id: string;
    filename: string;
    size: number;
    link: string;
    uploadedAt?: number;
    expiresAt?: number | null;
    downloads?: number;
    ratio?: string;
    isLocal: boolean;
}

export function InboxScreen({
    items,
    onRemove,
    onClear,
    signedIn,
    serverUrl,
    onUploadPress,
    onSettingsPress,
    onOpenAuth,
    onOpenLobby,
    onOpenSpaces,
    onOpenPair,
    onAddHistoryItem,
}: InboxScreenProps) {
    const toast = useToast();
    const [scope, setScope] = useState<'device' | 'cloud'>('device');
    const [selectedDetail, setSelectedDetail] = useState<DetailItem | null>(null);
    const [incomingTransfers, setIncomingTransfers] = useState<InboxItem[]>([]);
    const [pendingCount, setPendingCount] = useState(0);
    const [respondingId, setRespondingId] = useState<string | null>(null);

    // Fetch incoming user pushes if authenticated
    const loadIncomingInbox = useCallback(async () => {
        if (!signedIn) {
            setIncomingTransfers([]);
            setPendingCount(0);
            return;
        }
        try {
            const data = await fetchInboxTransfers(serverUrl);
            setIncomingTransfers(data.items.filter((i) => i.status === 'pending'));
            setPendingCount(data.pendingCount);
        } catch {
            // Ignored on transient failures
        }
    }, [serverUrl, signedIn]);

    useEffect(() => {
        loadIncomingInbox();
        if (signedIn) {
            const timer = setInterval(loadIncomingInbox, 10000);
            return () => clearInterval(timer);
        }
    }, [signedIn, loadIncomingInbox]);

    // Handle accept incoming transfer
    const handleAcceptIncoming = async (item: InboxItem) => {
        haptic.medium();
        setRespondingId(item.id);
        try {
            await respondToInboxTransfer(serverUrl, item.id, 'accept');

            const shareId = item.share_id || item.file_id;
            const link = `${serverUrl.replace(/\/+$/, '')}/v1/${shareId}`;
            const downloadUrl = `${serverUrl.replace(/\/+$/, '')}/api/stream?file=${shareId}&download=1`;

            // Auto-save file directly into local documents directory
            const saveRes = await autoSaveFile(downloadUrl, item.original_name);

            if (item.sender_id || item.sender_username) {
                await recordPeerTransfer({
                    id: item.sender_id || `user-${item.sender_username}`,
                    name: item.sender_username ? `@${item.sender_username}` : 'Datran User',
                    username: item.sender_username,
                    type: 'user',
                    serverUrl,
                });
            }

            onAddHistoryItem?.({
                id: shareId,
                filename: saveRes.filename || item.original_name || `received-file-${shareId.slice(0, 8)}`,
                size: saveRes.size || item.file_size || 0,
                mimeType: item.mime_type,
                link,
                serverUrl,
                uploadedAt: Date.now(),
                localUri: saveRes.localUri,
                savedLocally: saveRes.success,
            });

            haptic.success();
            toast.show(
                saveRes.success
                    ? `📥 Saved "${item.original_name}" directly to device storage!`
                    : `Accepted "${item.original_name}"! Added to transfers.`,
            );

            await loadIncomingInbox();
        } catch (err) {
            haptic.error();
            toast.show(`Could not accept: ${err instanceof Error ? err.message : String(err)}`, 'error');
        } finally {
            setRespondingId(null);
        }
    };

    // Handle decline incoming transfer
    const handleDeclineIncoming = async (item: InboxItem) => {
        haptic.light();
        setRespondingId(item.id);
        try {
            await respondToInboxTransfer(serverUrl, item.id, 'decline');
            toast.show(`Declined file from @${item.sender_username || 'user'}`);
            await loadIncomingInbox();
        } catch (err) {
            haptic.error();
            toast.show(`Could not decline: ${err instanceof Error ? err.message : String(err)}`, 'error');
        } finally {
            setRespondingId(null);
        }
    };

    // If sign-out occurs while viewing cloud vault, fallback to local device
    useEffect(() => {
        if (!signedIn && scope === 'cloud') {
            setScope('device');
        }
    }, [signedIn, scope]);

    const handleConfirmClear = () => {
        Alert.alert(
            'Clear Transfer History',
            'This removes the transfer records from this device only. Uploaded files remain active on the server until their expiration date.',
            [
                { text: 'Cancel', style: 'cancel' },
                {
                    text: 'Clear All',
                    style: 'destructive',
                    onPress: () => {
                        haptic.warning();
                        onClear();
                        toast.show('Device history cleared');
                    },
                },
            ],
        );
    };

    const handleRemoveItem = (id: string, name: string) => {
        haptic.light();
        onRemove(id);
        toast.show(`Removed ${name}`);
        if (selectedDetail?.id === id) setSelectedDetail(null);
    };

    return (
        <View style={styles.container}>
            <ScreenHeader
                title="Transfers"
                subtitle={signedIn ? 'Your active transfers, cloud vault & incoming files' : 'Files uploaded from this device'}
            />

            {/* INCOMING DIRECT USER TRANSFERS */}
            {signedIn && incomingTransfers.length > 0 ? (
                <View style={styles.incomingSection}>
                    <View style={styles.incomingHeader}>
                        <View style={styles.incomingBadgeRow}>
                            <Icon name="paper-plane" size={16} color={colors.primary} />
                            <Text style={styles.incomingTitle}>Incoming From Users</Text>
                        </View>
                        <Badge label={`${pendingCount} Pending`} tone="primary" />
                    </View>

                    {incomingTransfers.map((item) => (
                        <Card key={item.id} style={styles.incomingCard}>
                            <View style={styles.incomingCardTop}>
                                <FileIcon name={item.original_name || 'file'} mime={item.mime_type} size={36} />
                                <View style={styles.incomingMeta}>
                                    <Text style={styles.incomingFileName} numberOfLines={1}>
                                        {item.original_name}
                                    </Text>
                                    <Text style={styles.incomingSender}>
                                        Sent by <Text style={{ color: colors.primary, fontWeight: '700' }}>@{item.sender_username || 'user'}</Text>
                                        {' · '}{formatBytes(item.file_size)}
                                    </Text>
                                </View>
                            </View>

                            {item.message ? (
                                <Text style={styles.incomingMessage}>
                                    &ldquo;{item.message}&rdquo;
                                </Text>
                            ) : null}

                            <View style={styles.incomingActions}>
                                <Button
                                    label="Decline"
                                    variant="ghost"
                                    size="sm"
                                    disabled={respondingId === item.id}
                                    onPress={() => handleDeclineIncoming(item)}
                                />
                                <Button
                                    label="Accept & Save"
                                    icon="checkmark"
                                    variant="primary"
                                    size="sm"
                                    loading={respondingId === item.id}
                                    onPress={() => handleAcceptIncoming(item)}
                                />
                            </View>
                        </Card>
                    ))}
                </View>
            ) : null}

            {signedIn ? (
                <View style={styles.segmentWrapper}>
                    <SegmentedControl
                        value={scope}
                        onChange={(val) => setScope(val)}
                        segments={[
                            { key: 'device', label: 'This Device', count: items.length },
                            { key: 'cloud', label: 'Cloud Vault' },
                        ]}
                    />
                </View>
            ) : null}

            {scope === 'device' ? (
                <DeviceList
                    items={items}
                    onRemove={handleRemoveItem}
                    onClear={handleConfirmClear}
                    onUploadPress={onUploadPress}
                    signedIn={signedIn}
                    onOpenAuth={onOpenAuth}
                    onSelectDetail={(d) => setSelectedDetail(d)}
                />
            ) : (
                <CloudList
                    serverUrl={serverUrl}
                    onUploadPress={onUploadPress}
                    onSelectDetail={(d) => setSelectedDetail(d)}
                />
            )}

            {/* Mobile OmniPlayer In-app Preview Modal */}
            {selectedDetail ? (
                <MediaPreviewModal
                    visible={Boolean(selectedDetail)}
                    file={{
                        id: selectedDetail.id,
                        filename: selectedDetail.filename,
                        size: selectedDetail.size,
                        link: selectedDetail.link,
                        uploadedAt: selectedDetail.uploadedAt,
                        stats: selectedDetail.ratio ? { ratio: selectedDetail.ratio } : undefined,
                    }}
                    signedIn={signedIn}
                    serverUrl={serverUrl}
                    onClose={() => setSelectedDetail(null)}
                />
            ) : null}
        </View>
    );
}

function DeviceList({
    items,
    onRemove,
    onClear,
    onUploadPress,
    signedIn,
    onOpenAuth,
    onSelectDetail,
}: {
    items: HistoryItem[];
    onRemove: (id: string, name: string) => void;
    onClear: () => void;
    onUploadPress?: () => void;
    signedIn: boolean;
    onOpenAuth?: () => void;
    onSelectDetail: (item: DetailItem) => void;
}) {
    if (items.length === 0) {
        return (
            <View style={styles.emptyContainer}>
                <EmptyState
                    icon="file-tray-outline"
                    title="No Local Transfers"
                    message="Files uploaded from this device are indexed here with active share links and transfer details."
                    action={
                        onUploadPress ? (
                            <Button
                                label="Start New Transfer"
                                icon="cloud-upload-outline"
                                onPress={onUploadPress}
                                size="md"
                            />
                        ) : undefined
                    }
                />
                {!signedIn && onOpenAuth ? (
                    <Notice
                        tone="info"
                        title="Cloud Vault Available"
                        message="Sign in to sync your transfers across all devices and access larger file uploads."
                        action={
                            <Button
                                label="Sign In / Register"
                                variant="tonal"
                                size="sm"
                                icon="log-in-outline"
                                onPress={onOpenAuth}
                            />
                        }
                    />
                ) : null}
            </View>
        );
    }

    return (
        <View style={styles.list}>
            {!signedIn && onOpenAuth ? (
                <Notice
                    tone="info"
                    title="Device-Only Storage"
                    message="Sign in to your Datran account to sync and access your transfers across all devices."
                    action={
                        <Button
                            label="Sign In / Register"
                            variant="tonal"
                            size="sm"
                            icon="log-in-outline"
                            onPress={onOpenAuth}
                        />
                    }
                />
            ) : null}

            {items.map((item) => (
                <Pressable
                    key={item.id}
                    onPress={() => {
                        haptic.tap();
                        onSelectDetail({
                            id: item.id,
                            filename: item.filename,
                            size: item.size ?? 0,
                            link: item.link,
                            uploadedAt: item.uploadedAt,
                            ratio: item.stats?.ratio,
                            isLocal: true,
                        });
                    }}
                >
                    <Card style={styles.itemCard}>
                        <View style={styles.itemHeader}>
                            <FileIcon name={item.filename} size={42} />
                            <View style={styles.itemInfo}>
                                <Text style={styles.itemName} numberOfLines={1}>
                                    {item.filename}
                                </Text>
                                <View style={styles.metaRow}>
                                    <Badge label={formatBytes(item.size)} tone="neutral" />
                                    <Badge label={formatRelativeTime(item.uploadedAt)} tone="neutral" />
                                    {item.savedLocally || item.localUri ? (
                                        <Badge label="Saved to storage" tone="success" icon="checkmark-circle" />
                                    ) : null}
                                    {item.stats?.ratio ? (
                                        <Badge label={item.stats.ratio} tone="primary" />
                                    ) : null}
                                </View>
                            </View>
                            <IconButton
                                icon="trash-outline"
                                label={`Remove ${item.filename}`}
                                tint={colors.danger}
                                background={colors.dangerSoft}
                                size={36}
                                onPress={() => onRemove(item.id, item.filename)}
                            />
                        </View>

                        <View style={styles.linkRow}>
                            <Text style={styles.linkUrl} numberOfLines={1} selectable>
                                {item.link}
                            </Text>
                            <LinkActions link={item.link} filename={item.filename} variant="compact" />
                        </View>
                    </Card>
                </Pressable>
            ))}

            <View style={styles.clearWrapper}>
                <Button
                    label="Clear Device History"
                    icon="trash-outline"
                    variant="ghost"
                    size="sm"
                    onPress={onClear}
                />
                <Text style={styles.footnote}>
                    Clearing history only removes local records. Files remain active on the server until expiration.
                </Text>
            </View>
        </View>
    );
}

function CloudList({
    serverUrl,
    onUploadPress,
    onSelectDetail,
}: {
    serverUrl: string;
    onUploadPress?: () => void;
    onSelectDetail: (item: DetailItem) => void;
}) {
    const [state, setState] = useState<Remote>({ kind: 'loading' });
    const [reloadKey, setReloadKey] = useState(0);

    const load = useCallback(() => {
        setState({ kind: 'loading' });
        setReloadKey((k) => k + 1);
    }, []);

    useEffect(() => {
        let alive = true;
        fetchMyFiles(serverUrl).then(
            (files) => {
                if (alive) setState({ kind: 'ok', files });
            },
            (err: unknown) => {
                if (alive) setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
            },
        );
        return () => {
            alive = false;
        };
    }, [serverUrl, reloadKey]);

    return (
        <View style={styles.list}>
            <View style={styles.cloudSubheader}>
                <Text style={styles.cloudCount}>
                    {state.kind === 'ok' ? `${state.files.length} remote file${state.files.length === 1 ? '' : 's'}` : 'Connecting...'}
                </Text>
                <IconButton
                    icon="refresh-outline"
                    label="Refresh cloud files"
                    size={36}
                    onPress={load}
                    disabled={state.kind === 'loading'}
                />
            </View>

            {state.kind === 'loading' ? (
                <Card style={styles.loadingCard}>
                    <ActivityIndicator color={colors.primary} size="small" />
                    <Text style={styles.loadingText}>Synchronizing vault files...</Text>
                </Card>
            ) : null}

            {state.kind === 'error' ? (
                <Notice
                    tone="danger"
                    title="Failed to Load Cloud Files"
                    message={state.message}
                    action={<Button label="Retry" variant="secondary" size="sm" onPress={load} />}
                />
            ) : null}

            {state.kind === 'ok' && state.files.length === 0 ? (
                <EmptyState
                    icon="cloud-outline"
                    title="Vault is Empty"
                    message="No files currently indexed for this user account on the server."
                    action={
                        onUploadPress ? (
                            <Button
                                label="Upload File to Vault"
                                icon="cloud-upload-outline"
                                size="md"
                                onPress={onUploadPress}
                            />
                        ) : undefined
                    }
                />
            ) : null}

            {state.kind === 'ok'
                ? state.files.map((f) => {
                      const expiryTime = f.expires_at ? new Date(f.expires_at).getTime() : null;
                      const expiryText = formatExpiry(expiryTime);
                      const isExpired = expiryText === 'Expired';

                      return (
                          <Pressable
                              key={f.share_id}
                              onPress={() => {
                                  haptic.tap();
                                  onSelectDetail({
                                      id: f.share_id,
                                      filename: f.original_name,
                                      size: f.file_size,
                                      link: f.link,
                                      uploadedAt: f.created_at,
                                      expiresAt: f.expires_at,
                                      downloads: f.downloads,
                                      isLocal: false,
                                  });
                              }}
                          >
                              <Card style={styles.itemCard}>
                                  <View style={styles.itemHeader}>
                                      <FileIcon name={f.original_name} size={42} />
                                      <View style={styles.itemInfo}>
                                          <Text style={styles.itemName} numberOfLines={1}>
                                              {f.original_name}
                                          </Text>
                                          <View style={styles.metaRow}>
                                              <Badge label={formatBytes(f.file_size)} tone="neutral" />
                                              <Badge
                                                  label={`${f.downloads} dl`}
                                                  tone={f.downloads > 0 ? 'primary' : 'neutral'}
                                              />
                                              {expiryText ? (
                                                  <Badge
                                                      label={expiryText}
                                                      tone={isExpired ? 'danger' : 'warning'}
                                                  />
                                              ) : null}
                                          </View>
                                      </View>
                                  </View>

                                  <View style={styles.linkRow}>
                                      <Text style={styles.linkUrl} numberOfLines={1} selectable>
                                          {f.link}
                                      </Text>
                                      <LinkActions link={f.link} filename={f.original_name} variant="compact" />
                                  </View>
                              </Card>
                          </Pressable>
                      );
                  })
                : null}
        </View>
    );
}

function FileDetailModal({
    item,
    onClose,
    onRemove,
}: {
    item: DetailItem;
    onClose: () => void;
    onRemove?: () => void;
}) {
    const toast = useToast();
    const expiryTime = item.expiresAt;
    const expiryText = formatExpiry(expiryTime);

    const handleCopy = async () => {
        try {
            await Clipboard.setStringAsync(item.link);
            toast.show('Share link copied to clipboard');
        } catch {
            toast.show('Could not copy link', 'error');
        }
    };

    const handleOpenBrowser = async () => {
        try {
            await Linking.openURL(item.link);
        } catch {
            toast.show('Could not open URL', 'error');
        }
    };

    return (
        <Modal visible transparent animationType="slide" onRequestClose={onClose}>
            <View style={styles.modalBackdrop}>
                <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
                <View style={styles.modalSheet}>
                    <View style={styles.modalHeader}>
                        <FileIcon name={item.filename} size={48} />
                        <View style={styles.modalTitleBlock}>
                            <Text style={styles.modalFilename} numberOfLines={2}>
                                {item.filename}
                            </Text>
                            <Text style={styles.modalSubtitle}>
                                {formatBytes(item.size)} · {item.isLocal ? 'On this device' : 'In Cloud Vault'}
                            </Text>
                        </View>
                        <Pressable style={styles.modalCloseBtn} onPress={onClose}>
                            <Icon name="close" size={20} color={colors.textMuted} />
                        </Pressable>
                    </View>

                    {/* Metadata details */}
                    <View style={styles.metaGrid}>
                        <View style={styles.metaTile}>
                            <Text style={styles.metaTileLabel}>Size</Text>
                            <Text style={styles.metaTileValue}>{formatBytes(item.size)}</Text>
                        </View>
                        {item.uploadedAt ? (
                            <View style={styles.metaTile}>
                                <Text style={styles.metaTileLabel}>Uploaded</Text>
                                <Text style={styles.metaTileValue}>{formatRelativeTime(item.uploadedAt)}</Text>
                            </View>
                        ) : null}
                        {expiryText ? (
                            <View style={styles.metaTile}>
                                <Text style={styles.metaTileLabel}>Status</Text>
                                <Text style={[styles.metaTileValue, expiryText === 'Expired' && { color: colors.danger }]}>
                                    {expiryText}
                                </Text>
                            </View>
                        ) : null}
                        {item.downloads !== undefined ? (
                            <View style={styles.metaTile}>
                                <Text style={styles.metaTileLabel}>Downloads</Text>
                                <Text style={styles.metaTileValue}>{item.downloads}</Text>
                            </View>
                        ) : null}
                    </View>

                    {/* Share Link Box */}
                    <View style={styles.shareBox}>
                        <Text style={styles.shareLabel}>Share Link</Text>
                        <View style={styles.shareUrlRow}>
                            <Text style={styles.shareUrl} numberOfLines={1} selectable>
                                {item.link}
                            </Text>
                        </View>
                        <LinkActions link={item.link} filename={item.filename} variant="full" />
                    </View>

                    {/* Secondary Actions */}
                    <View style={styles.modalActions}>
                        <Button
                            label="Open in Web Preview"
                            icon="open-outline"
                            variant="secondary"
                            size="md"
                            fullWidth
                            onPress={handleOpenBrowser}
                        />
                        {onRemove ? (
                            <Button
                                label="Remove from Device History"
                                icon="trash-outline"
                                variant="ghost"
                                size="sm"
                                onPress={onRemove}
                            />
                        ) : null}
                    </View>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    container: {
        gap: space.md,
    },
    segmentWrapper: {
        marginBottom: space.xs,
    },
    list: {
        gap: space.sm,
    },
    emptyContainer: {
        gap: space.md,
    },
    itemCard: {
        gap: space.sm,
        padding: space.md,
    },
    itemHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    itemInfo: {
        flex: 1,
        gap: 4,
    },
    itemName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
    },
    metaRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: 6,
        alignItems: 'center',
    },
    linkRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.backgroundElevated,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        paddingLeft: space.sm,
        paddingRight: 4,
        paddingVertical: 4,
        gap: space.sm,
    },
    linkUrl: {
        color: colors.primary,
        fontSize: 12,
        fontFamily: 'monospace',
        flex: 1,
    },
    clearWrapper: {
        alignItems: 'center',
        marginTop: space.sm,
        gap: space.xs,
    },
    footnote: {
        color: colors.textFaint,
        fontSize: 11,
        lineHeight: 16,
        textAlign: 'center',
        paddingHorizontal: space.md,
    },
    cloudSubheader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 4,
    },
    cloudCount: {
        color: colors.textMuted,
        fontSize: 12,
        fontWeight: '600',
    },
    loadingCard: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
        paddingVertical: space.xl,
    },
    loadingText: {
        color: colors.textMuted,
        fontSize: 13,
    },
    modalBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.75)',
        justifyContent: 'flex-end',
    },
    modalSheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        padding: space.xl,
        paddingBottom: space.xxxl,
        gap: space.lg,
    },
    modalHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        position: 'relative',
    },
    modalTitleBlock: {
        flex: 1,
        gap: 2,
    },
    modalFilename: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '700',
    },
    modalSubtitle: {
        color: colors.textMuted,
        fontSize: 12,
    },
    modalCloseBtn: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.surfaceRaised,
        alignItems: 'center',
        justifyContent: 'center',
    },
    metaGrid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        gap: space.sm,
    },
    metaTile: {
        flex: 1,
        minWidth: '45%',
        backgroundColor: colors.backgroundElevated,
        borderRadius: radius.md,
        padding: space.md,
        gap: 2,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.border,
    },
    metaTileLabel: {
        color: colors.textFaint,
        fontSize: 11,
        fontWeight: '600',
    },
    metaTileValue: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
    },
    shareBox: {
        gap: space.sm,
    },
    shareLabel: {
        color: colors.textMuted,
        fontSize: 13,
        fontWeight: '600',
    },
    shareUrlRow: {
        backgroundColor: colors.backgroundElevated,
        borderRadius: radius.md,
        padding: space.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.border,
    },
    shareUrl: {
        color: colors.primary,
        fontSize: 12,
        fontFamily: 'monospace',
    },
    modalActions: {
        gap: space.sm,
        alignItems: 'center',
    },
    hubBar: {
        flexDirection: 'row',
        gap: space.sm,
        marginBottom: space.md,
    },
    hubPill: {
        flex: 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        paddingVertical: 10,
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
    },
    hubPillPressed: {
        backgroundColor: colors.surfacePressed,
    },
    hubPillText: {
        color: colors.text,
        fontSize: 12,
        fontWeight: '700',
    },
    incomingSection: {
        gap: space.sm,
        marginBottom: space.lg,
    },
    incomingHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 2,
    },
    incomingBadgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    incomingTitle: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.5,
    },
    incomingCard: {
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        borderRadius: radius.lg,
        padding: space.md,
        gap: space.sm,
    },
    incomingCardTop: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
    },
    incomingMeta: {
        flex: 1,
        minWidth: 0,
    },
    incomingFileName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
    },
    incomingSender: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 2,
    },
    incomingMessage: {
        color: colors.textMuted,
        fontSize: 12,
        fontStyle: 'italic',
        backgroundColor: colors.backgroundElevated,
        padding: space.sm,
        borderRadius: radius.sm,
        borderLeftWidth: 2,
        borderLeftColor: colors.primary,
    },
    incomingActions: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: space.sm,
        marginTop: 2,
    },
});
