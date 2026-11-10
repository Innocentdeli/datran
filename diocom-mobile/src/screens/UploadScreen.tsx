import { useEffect, useRef, useState } from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import {
    ApiError,
    UploadCancelledError,
    uploadDocument,
    type UploadProgress,
    type UploadSuccess,
} from '../api/client';
import { LinkActions } from '../components/LinkActions';
import { MediaPreviewModal, type PreviewableFile } from './MediaPreviewModal';
import { EmailTransferModal } from './EmailTransferModal';
import { UserPushModal } from './UserPushModal';
import type { HistoryItem } from '../storage/history';
import type { Settings } from '../storage/settings';
import {
    colors,
    formatBytes,
    formatDuration,
    formatRate,
    formatRelativeTime,
    radius,
    space,
    type,
} from '../theme';
import {
    Badge,
    Button,
    Card,
    FileIcon,
    haptic,
    Icon,
    IconButton,
    Notice,
    ProgressBar,
    Section,
    SegmentedControl,
    TextField,
    useToast,
} from '../ui';

interface UploadScreenProps {
    settings: Settings;
    signedIn: boolean;
    recentItems?: HistoryItem[];
    sharedAsset?: DocumentPicker.DocumentPickerAsset | null;
    onUploaded: (item: HistoryItem) => void;
    onOpenSettings: () => void;
    onOpenInbox?: () => void;
    onOpenFileRequests?: () => void;
    onOpenLobby?: () => void;
    onOpenSpaces?: () => void;
    onOpenRadar?: () => void;
    onOpenPair?: () => void;
}

const EXPIRY_CHOICES = [
    { key: '24', label: '24 Hours' },
    { key: '72', label: '3 Days' },
    { key: '168', label: '7 Days' },
    { key: '720', label: '30 Days' },
];

export function UploadScreen({
    settings,
    signedIn,
    recentItems = [],
    sharedAsset,
    onUploaded,
    onOpenSettings,
    onOpenInbox,
    onOpenFileRequests,
    onOpenLobby,
    onOpenSpaces,
    onOpenRadar,
    onOpenPair,
}: UploadScreenProps) {
    const toast = useToast();
    const abortRef = useRef<AbortController | null>(null);

    // Selected files queue
    const [selectedAssets, setSelectedAssets] = useState<DocumentPicker.DocumentPickerAsset[]>([]);
    const [password, setPassword] = useState('');
    const [showPasswordInput, setShowPasswordInput] = useState(false);
    const [expiryHours, setExpiryHours] = useState(String(settings.defaultExpiryHours ?? 72));

    // Transfer status
    const [uploading, setUploading] = useState(false);
    const [transferStatus, setTransferStatus] = useState<'uploading' | 'reconnecting' | 'resuming'>('uploading');
    const [retryAttempt, setRetryAttempt] = useState(0);
    const [currentFileIdx, setCurrentFileIdx] = useState(0);
    const [currentProgress, setCurrentProgress] = useState<UploadProgress | null>(null);
    const [startedAt, setStartedAt] = useState<number>(0);
    const [completedLinks, setCompletedLinks] = useState<{ name: string; link: string; size: number }[]>([]);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [pushItem, setPushItem] = useState<{ shareId: string; filename: string } | null>(null);
    const [emailModalFile, setEmailModalFile] = useState<{ id: string; name: string; link: string } | null>(null);
    const [previewFile, setPreviewFile] = useState<PreviewableFile | null>(null);

    // Cancel in-flight upload on unmount
    useEffect(() => () => abortRef.current?.abort(), []);

    // Handle incoming shared asset from OS Share Sheet
    useEffect(() => {
        if (sharedAsset) {
            setSelectedAssets([sharedAsset]);
            setCompletedLinks([]);
            setErrorMessage(null);
            haptic.light();
        }
    }, [sharedAsset]);

    const canUpload = settings.anonymousUploads || signedIn;
    const totalBytes = selectedAssets.reduce((sum, a) => sum + (a.size ?? 0), 0);

    const pickFiles = async () => {
        haptic.light();
        try {
            const picked = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
                multiple: true,
            });
            if (picked.canceled || !picked.assets?.length) return;
            setSelectedAssets((prev) => {
                const existingNames = new Set(prev.map((p) => p.name));
                const fresh = picked.assets.filter((a) => !existingNames.has(a.name));
                return [...prev, ...fresh];
            });
            setErrorMessage(null);
        } catch (err) {
            toast.show(`Could not pick file: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
    };

    const pickFromGallery = async () => {
        haptic.light();
        try {
            const res = await ImagePicker.launchImageLibraryAsync({
                mediaTypes: ['images', 'videos'],
                allowsMultipleSelection: true,
                quality: 1,
            });
            if (res.canceled || !res.assets?.length) return;
            const converted: DocumentPicker.DocumentPickerAsset[] = res.assets.map((a, idx) => ({
                uri: a.uri,
                name: a.fileName || `media-${Date.now()}-${idx}.${a.mimeType?.split('/')[1] || 'jpg'}`,
                size: a.fileSize ?? 0,
                mimeType: a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
                lastModified: Date.now(),
            }));
            setSelectedAssets((prev) => {
                const existingNames = new Set(prev.map((p) => p.name));
                const fresh = converted.filter((a) => !existingNames.has(a.name));
                return [...prev, ...fresh];
            });
            setErrorMessage(null);
        } catch (err) {
            toast.show(`Could not pick media: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
    };

    const takePhoto = async () => {
        haptic.light();
        try {
            const perm = await ImagePicker.requestCameraPermissionsAsync();
            if (!perm.granted) {
                toast.show('Camera access is required to capture photos', 'error');
                return;
            }
            const res = await ImagePicker.launchCameraAsync({
                mediaTypes: ['images', 'videos'],
                quality: 1,
            });
            if (res.canceled || !res.assets?.length) return;
            const a = res.assets[0];
            if (!a) return;
            const converted: DocumentPicker.DocumentPickerAsset = {
                uri: a.uri,
                name: a.fileName || `camera-${Date.now()}.${a.mimeType?.split('/')[1] || 'jpg'}`,
                size: a.fileSize ?? 0,
                mimeType: a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
                lastModified: Date.now(),
            };
            setSelectedAssets((prev) => [...prev, converted]);
            setErrorMessage(null);
        } catch (err) {
            toast.show(`Could not capture photo: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
    };

    const removeAsset = (index: number) => {
        haptic.light();
        setSelectedAssets((prev) => prev.filter((_, i) => i !== index));
    };

    const reset = () => {
        setSelectedAssets([]);
        setPassword('');
        setShowPasswordInput(false);
        setCompletedLinks([]);
        setErrorMessage(null);
        setUploading(false);
        setCurrentProgress(null);
    };

    const startUpload = async () => {
        if (!selectedAssets.length || uploading) return;
        haptic.medium();
        setUploading(true);
        setErrorMessage(null);
        setCompletedLinks([]);
        setCurrentFileIdx(0);
        setCurrentProgress(null);
        setStartedAt(Date.now());

        const controller = new AbortController();
        abortRef.current = controller;

        const results: { name: string; link: string; size: number }[] = [];

        try {
            for (let i = 0; i < selectedAssets.length; i++) {
                if (controller.signal.aborted) break;
                const asset = selectedAssets[i];
                if (!asset) continue;
                setCurrentFileIdx(i);
                setCurrentProgress(null);

                const res: UploadSuccess = await uploadDocument({
                    serverUrl: settings.serverUrl,
                    asset,
                    password: password.trim() || undefined,
                    expiresInHours: Number(expiryHours),
                    signal: controller.signal,
                    onProgress: (p) => setCurrentProgress(p),
                    onStatusChange: (status, attempt) => {
                        setTransferStatus(status);
                        if (attempt !== undefined) setRetryAttempt(attempt);
                    },
                });

                results.push({ name: asset.name, link: res.link, size: asset.size ?? 0 });

                onUploaded({
                    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    filename: asset.name,
                    size: asset.size ?? 0,
                    mimeType: asset.mimeType,
                    link: res.link,
                    serverUrl: settings.serverUrl,
                    uploadedAt: Date.now(),
                    stats: res.stats,
                });
            }

            haptic.success();
            setCompletedLinks(results);
            toast.show(
                results.length > 1
                    ? `${results.length} files uploaded successfully`
                    : 'File uploaded and link ready',
            );
        } catch (err) {
            if (err instanceof UploadCancelledError) {
                haptic.warning();
                toast.show('Upload cancelled');
            } else {
                haptic.error();
                const msg = err instanceof ApiError || err instanceof Error ? err.message : String(err);
                setErrorMessage(msg);
            }
        } finally {
            setUploading(false);
            abortRef.current = null;
        }
    };

    const cancelUpload = () => {
        abortRef.current?.abort();
    };

    // Upload speed and ETA calculation
    const currentAsset = selectedAssets[currentFileIdx];
    const uploadRate = (() => {
        if (!currentProgress || currentProgress.totalBytes <= 0 || startedAt <= 0) return null;
        const elapsed = Math.max(0.3, (Date.now() - startedAt) / 1000);
        const rate = currentProgress.bytesSent / elapsed;
        const remaining = Math.max(0, currentProgress.totalBytes - currentProgress.bytesSent);
        const eta = rate > 0 ? remaining / rate : null;
        return { rate, eta };
    })();

    return (
        <View style={styles.container}>
            {/* AUTH NOTIFICATION IF ANONYMOUS DISABLED */}
            {!canUpload ? (
                <Notice
                    tone="warning"
                    title="Sign-In Required"
                    message="Anonymous uploads are disabled on this server. Please sign in to send files."
                    action={<Button label="Sign In" size="sm" variant="tonal" onPress={onOpenSettings} />}
                />
            ) : null}

            {/* ERROR NOTICE */}
            {errorMessage ? (
                <Notice
                    tone="danger"
                    title="Upload Failed"
                    message={errorMessage}
                    action={<Button label="Try Again" size="sm" variant="secondary" onPress={startUpload} />}
                />
            ) : null}

            {/* STATE 1: SUCCESSFUL TRANSFER */}
            {completedLinks.length > 0 ? (
                <Card style={styles.doneCard}>
                    <View style={styles.doneIconWrap}>
                        <Icon name="checkmark-circle" size={44} color={colors.primary} />
                    </View>
                    <Text style={styles.doneTitle}>
                        {completedLinks.length > 1 ? 'Files Ready to Share' : 'Your Link is Ready'}
                    </Text>
                    <Text style={styles.doneSubtitle}>
                        {completedLinks.length} file{completedLinks.length > 1 ? 's' : ''} · {formatBytes(totalBytes)}
                    </Text>

                    {/* Metadata tags */}
                    <View style={styles.badgesRow}>
                        <Badge
                            label={`Expires in ${Math.round(Number(expiryHours) / 24)} days`}
                            tone="primary"
                            icon="time-outline"
                        />
                        {password.trim() ? (
                            <Badge label="Password Protected" tone="warning" icon="lock-closed-outline" />
                        ) : null}
                    </View>

                    {/* Links */}
                    <View style={styles.linksContainer}>
                        {completedLinks.map((item, idx) => (
                            <View key={idx} style={styles.linkItem}>
                                <View style={styles.linkHeader}>
                                    <FileIcon name={item.name} size={28} />
                                    <Text style={styles.linkFilename} numberOfLines={1}>
                                        {item.name}
                                    </Text>
                                </View>
                                <View style={styles.urlBar}>
                                    <Text style={styles.urlText} numberOfLines={1} selectable>
                                        {item.link}
                                    </Text>
                                </View>
                                <View style={styles.completedActionsRow}>
                                    <LinkActions link={item.link} filename={item.name} variant="full" />
                                    <Button
                                        label="Send by Email"
                                        icon="mail-outline"
                                        variant="tonal"
                                        size="sm"
                                        onPress={() => {
                                            const shareId = item.link.split('/').pop() || '';
                                            setEmailModalFile({ id: shareId, name: item.name, link: item.link });
                                        }}
                                    />
                                    {signedIn ? (
                                        <Button
                                            label="@User"
                                            icon="paper-plane"
                                            variant="ghost"
                                            size="sm"
                                            onPress={() => {
                                                const shareId = item.link.split('/').pop() || '';
                                                setPushItem({ shareId, filename: item.name });
                                            }}
                                        />
                                    ) : null}
                                </View>
                            </View>
                        ))}
                    </View>

                    <Button
                        label="Send Another File"
                        icon="arrow-forward-outline"
                        variant="ghost"
                        size="md"
                        onPress={reset}
                    />
                </Card>
            ) : uploading ? (
                /* STATE 2: UPLOADING */
                <Card style={styles.uploadingCard}>
                    <View style={styles.uploadingHeader}>
                        <FileIcon name={currentAsset?.name ?? 'upload'} size={48} />
                        <View style={styles.uploadingInfo}>
                            {transferStatus === 'reconnecting' ? (
                                <Badge
                                    label={`RECONNECTING (${retryAttempt}/5) • AUTO-RESUMING`}
                                    tone="warning"
                                    icon="sync"
                                />
                            ) : transferStatus === 'resuming' ? (
                                <Badge
                                    label="RESUMING TRANSFER STREAM"
                                    tone="warning"
                                    icon="sync"
                                />
                            ) : (
                                <Badge
                                    label={`UPLOADING ${currentFileIdx + 1} OF ${selectedAssets.length}`}
                                    tone="primary"
                                    icon="sync"
                                />
                            )}
                            <Text style={styles.uploadingName} numberOfLines={1}>
                                {currentAsset?.name}
                            </Text>
                            <Text style={styles.uploadingBytes}>
                                {currentProgress
                                    ? `${formatBytes(currentProgress.bytesSent)} of ${formatBytes(currentProgress.totalBytes)}`
                                    : 'Preparing transfer...'}
                            </Text>
                        </View>
                    </View>

                    <ProgressBar
                        progress={
                            currentProgress && currentProgress.totalBytes > 0
                                ? currentProgress.bytesSent / currentProgress.totalBytes
                                : null
                        }
                        height={8}
                    />

                    <View style={styles.telemetryRow}>
                        <Text style={styles.telemetryText}>
                            Speed: {uploadRate ? formatRate(uploadRate.rate) : 'measuring...'}
                        </Text>
                        <Text style={styles.telemetryText}>
                            Time left: {uploadRate?.eta ? formatDuration(uploadRate.eta) : 'calculating...'}
                        </Text>
                    </View>

                    <Button
                        label="Cancel Transfer"
                        icon="close-outline"
                        variant="ghost"
                        size="sm"
                        onPress={cancelUpload}
                    />
                </Card>
            ) : selectedAssets.length > 0 ? (
                /* STATE 3: FILES SELECTED — CONFIGURE OPTIONS */
                <View style={styles.selectedSection}>
                    <Card style={styles.queueCard}>
                        <View style={styles.queueHeader}>
                            <Text style={styles.queueTitle}>
                                Selected Files ({selectedAssets.length})
                            </Text>
                            <Text style={styles.queueSize}>
                                {formatBytes(totalBytes)}
                            </Text>
                        </View>

                        <View style={styles.fileList}>
                            {selectedAssets.map((asset, index) => {
                                const ext = asset.name.split('.').pop()?.toLowerCase() || '';
                                const isImg =
                                    Boolean(asset.mimeType?.startsWith('image/')) ||
                                    ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext);

                                return (
                                    <Pressable
                                        key={`${asset.name}-${index}`}
                                        style={styles.fileRow}
                                        onPress={() => {
                                            haptic.tap();
                                            setPreviewFile({
                                                filename: asset.name,
                                                link: asset.uri,
                                                size: asset.size ?? 0,
                                                mimeType: asset.mimeType,
                                            });
                                        }}
                                    >
                                        {isImg ? (
                                            <Image source={{ uri: asset.uri }} style={styles.thumbnailImg} resizeMode="cover" />
                                        ) : (
                                            <FileIcon name={asset.name} mime={asset.mimeType} size={36} />
                                        )}
                                        <View style={styles.fileMeta}>
                                            <Text style={styles.fileName} numberOfLines={1}>
                                                {asset.name}
                                            </Text>
                                            <Text style={styles.fileSize}>
                                                {formatBytes(asset.size ?? 0)} · Tap to preview
                                            </Text>
                                        </View>
                                        <IconButton
                                            icon="close"
                                            label={`Remove ${asset.name}`}
                                            size={32}
                                            onPress={() => removeAsset(index)}
                                        />
                                    </Pressable>
                                );
                            })}
                        </View>

                        <View style={styles.addMoreRow}>
                            <Button label="+ Photos" variant="ghost" size="sm" onPress={pickFromGallery} />
                            <Button label="+ Camera" variant="ghost" size="sm" onPress={takePhoto} />
                            <Button label="+ Files" variant="ghost" size="sm" onPress={pickFiles} />
                        </View>
                    </Card>

                    {/* TRANSFER SECURITY & EXPIRY OPTIONS */}
                    <Card style={styles.optionsCard}>
                        <Text style={styles.optionsTitle}>Link Security & Expiration</Text>

                        {/* Link Expiration Selector */}
                        <View style={styles.optionBlock}>
                            <Text style={styles.optionLabel}>Expires After</Text>
                            <SegmentedControl
                                value={expiryHours}
                                onChange={(val) => setExpiryHours(val)}
                                segments={EXPIRY_CHOICES}
                            />
                        </View>

                        {/* Password Protection (Optional) */}
                        <View style={styles.optionBlock}>
                            <View style={styles.passwordHeader}>
                                <Text style={styles.optionLabel}>Password Protection</Text>
                                {!showPasswordInput && !password ? (
                                    <Button
                                        label="+ Add Password"
                                        variant="ghost"
                                        size="sm"
                                        onPress={() => setShowPasswordInput(true)}
                                    />
                                ) : null}
                            </View>

                            {showPasswordInput || password ? (
                                <TextField
                                    label="PASSWORD"
                                    value={password}
                                    onChangeText={setPassword}
                                    placeholder="Enter access password"
                                    icon="lock-closed-outline"
                                    secureTextEntry
                                    revealable
                                    hint="Recipients must enter this password to view or download the file."
                                />
                            ) : null}
                        </View>
                    </Card>

                    {/* UPLOAD ACTION */}
                    <View style={styles.actionWrap}>
                        <Button
                            label={`Upload & Get Link (${formatBytes(totalBytes)})`}
                            icon="cloud-upload-outline"
                            variant="primary"
                            size="lg"
                            fullWidth
                            disabled={!canUpload}
                            onPress={startUpload}
                        />
                        <Button
                            label="Clear Selection"
                            variant="ghost"
                            size="sm"
                            onPress={reset}
                        />
                    </View>
                </View>
            ) : (
                /* STATE 4: COMMAND CENTER (IDLE) */
                <View style={styles.commandCard}>
                    <View style={styles.commandHeader}>
                        <View style={styles.commandIconGlow}>
                            <Icon name="flash" size={26} color={colors.primary} />
                        </View>
                        <Text style={styles.commandTitle}>Send Files Securely</Text>
                        <Text style={styles.commandSubtitle}>
                            End-to-end encrypted · Direct delivery or shareable link
                        </Text>
                        <View style={styles.dropzoneBadges}>
                            <Badge label="E2E Encrypted" tone="primary" icon="shield-checkmark" />
                            <Badge label="Auto-Expire" tone="neutral" icon="time-outline" />
                            <Badge label="Resumable" tone="success" icon="flash" />
                        </View>
                    </View>

                    {/* 3 QUICK SELECTOR BUTTONS */}
                    <View style={styles.pickerActionsRow}>
                        <Pressable
                            onPress={takePhoto}
                            style={({ pressed }) => [styles.pickerActionBtn, pressed && styles.pickerActionBtnPressed]}
                            accessibilityRole="button"
                            accessibilityLabel="Take a photo with camera"
                        >
                            <View style={[styles.pickerActionIcon, { backgroundColor: colors.primarySoft }]}>
                                <Icon name="camera" size={22} color={colors.primary} />
                            </View>
                            <Text style={styles.pickerActionLabel}>Camera</Text>
                            <Text style={styles.pickerActionSub}>Instant Snap</Text>
                        </Pressable>

                        <Pressable
                            onPress={pickFromGallery}
                            style={({ pressed }) => [styles.pickerActionBtn, pressed && styles.pickerActionBtnPressed]}
                            accessibilityRole="button"
                            accessibilityLabel="Select from photo library"
                        >
                            <View style={[styles.pickerActionIcon, { backgroundColor: colors.violetSoft }]}>
                                <Icon name="images" size={22} color={colors.violet} />
                            </View>
                            <Text style={styles.pickerActionLabel}>Photos</Text>
                            <Text style={styles.pickerActionSub}>Media Roll</Text>
                        </Pressable>

                        <Pressable
                            onPress={pickFiles}
                            style={({ pressed }) => [styles.pickerActionBtn, pressed && styles.pickerActionBtnPressed]}
                            accessibilityRole="button"
                            accessibilityLabel="Browse device files"
                        >
                            <View style={[styles.pickerActionIcon, { backgroundColor: colors.successSoft }]}>
                                <Icon name="document-text" size={22} color={colors.success} />
                            </View>
                            <Text style={styles.pickerActionLabel}>Files</Text>
                            <Text style={styles.pickerActionSub}>Any Format</Text>
                        </Pressable>
                    </View>
                </View>
            )}

            {/* RECENT TRANSFERS SECTION */}
            {recentItems.length > 0 && !uploading && completedLinks.length === 0 ? (
                <Section
                    title="RECENT TRANSFERS"
                    right={
                        onOpenInbox ? (
                            <Button
                                label="View All"
                                variant="ghost"
                                size="sm"
                                onPress={onOpenInbox}
                            />
                        ) : undefined
                    }
                >
                    {recentItems.slice(0, 3).map((item) => (
                        <Pressable
                            key={item.id}
                            style={styles.recentRow}
                            onPress={() => {
                                haptic.tap();
                                setPreviewFile({
                                    filename: item.filename,
                                    link: item.link,
                                    size: item.size ?? 0,
                                    uploadedAt: item.uploadedAt,
                                    stats: item.stats,
                                });
                            }}
                        >
                            <FileIcon name={item.filename} size={36} />
                            <View style={styles.recentInfo}>
                                <Text style={styles.recentName} numberOfLines={1}>
                                    {item.filename}
                                </Text>
                                <Text style={styles.recentMeta}>
                                    {formatBytes(item.size)} · {formatRelativeTime(item.uploadedAt)}
                                </Text>
                            </View>
                            <LinkActions link={item.link} filename={item.filename} variant="compact" />
                        </Pressable>
                    ))}
                </Section>
            ) : null}

            {/* USER DIRECT INBOX PUSH MODAL */}
            {pushItem ? (
                <UserPushModal
                    visible={true}
                    serverUrl={settings.serverUrl}
                    shareId={pushItem.shareId}
                    filename={pushItem.filename}
                    onClose={() => setPushItem(null)}
                />
            ) : null}

            {/* SEND VIA EMAIL MODAL */}
            {emailModalFile ? (
                <EmailTransferModal
                    visible={true}
                    fileId={emailModalFile.id}
                    fileName={emailModalFile.name}
                    link={emailModalFile.link}
                    serverUrl={settings.serverUrl}
                    onClose={() => setEmailModalFile(null)}
                />
            ) : null}

            {/* IN-APP MEDIA PREVIEW MODAL */}
            <MediaPreviewModal
                visible={Boolean(previewFile)}
                file={previewFile}
                signedIn={signedIn}
                serverUrl={settings.serverUrl}
                onClose={() => setPreviewFile(null)}
                onSendToUser={(p) => setPushItem(p)}
            />
        </View>
    );

}

const styles = StyleSheet.create({
    container: {
        gap: space.lg,
    },
    dropzone: {
        alignItems: 'center',
        paddingVertical: space.xxxl,
        paddingHorizontal: space.xl,
        borderRadius: radius.xl,
        borderWidth: 2,
        borderStyle: 'dashed',
        borderColor: colors.borderStrong,
        backgroundColor: colors.surface,
        gap: space.md,
    },
    dropzonePressed: {
        backgroundColor: colors.surfaceRaised,
        borderColor: colors.primary,
    },
    dropzoneIconWrap: {
        width: 72,
        height: 72,
        borderRadius: 36,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    dropzoneTitle: {
        color: colors.text,
        fontSize: 20,
        fontWeight: '800',
        letterSpacing: 0.3,
    },
    dropzoneSubtitle: {
        color: colors.textMuted,
        fontSize: 13,
        textAlign: 'center',
        maxWidth: 280,
    },
    dropzoneBadges: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: space.xs,
        marginVertical: space.xs,
        maxWidth: '100%',
    },
    selectedSection: {
        gap: space.md,
    },
    queueCard: {
        gap: space.md,
        padding: space.lg,
    },
    queueHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: colors.border,
        paddingBottom: space.sm,
    },
    queueTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    queueSize: {
        color: colors.textMuted,
        fontSize: 13,
        fontWeight: '600',
    },
    fileList: {
        gap: space.sm,
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: 4,
    },
    fileMeta: {
        flex: 1,
        gap: 2,
    },
    fileName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    fileSize: {
        color: colors.textFaint,
        fontSize: 12,
    },
    optionsCard: {
        gap: space.md,
        padding: space.lg,
    },
    optionsTitle: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    optionBlock: {
        gap: space.xs,
    },
    optionLabel: {
        color: colors.textMuted,
        fontSize: 13,
        fontWeight: '600',
    },
    passwordHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    actionWrap: {
        alignItems: 'center',
        gap: space.sm,
    },
    uploadingCard: {
        gap: space.lg,
        padding: space.xl,
    },
    uploadingHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
    },
    uploadingInfo: {
        flex: 1,
        gap: 4,
    },
    uploadingName: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    uploadingBytes: {
        color: colors.textMuted,
        fontSize: 12,
    },
    telemetryRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    telemetryText: {
        color: colors.textFaint,
        fontSize: 12,
    },
    doneCard: {
        alignItems: 'center',
        padding: space.xl,
        gap: space.md,
    },
    doneIconWrap: {
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: colors.primarySoft,
        alignItems: 'center',
        justifyContent: 'center',
    },
    doneTitle: {
        color: colors.text,
        fontSize: 20,
        fontWeight: '800',
    },
    doneSubtitle: {
        color: colors.textMuted,
        fontSize: 13,
    },
    badgesRow: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: space.xs,
    },
    linksContainer: {
        width: '100%',
        gap: space.md,
        marginVertical: space.sm,
    },
    linkItem: {
        backgroundColor: colors.backgroundElevated,
        borderRadius: radius.md,
        padding: space.md,
        gap: space.sm,
        borderWidth: StyleSheet.hairlineWidth * 2,
        borderColor: colors.border,
    },
    linkHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    linkFilename: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
        flex: 1,
    },
    urlBar: {
        backgroundColor: colors.surface,
        borderRadius: radius.sm,
        paddingHorizontal: space.sm,
        paddingVertical: 6,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
    },
    urlText: {
        color: colors.primary,
        fontSize: 12,
        fontFamily: 'monospace',
    },
    recentRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
    },
    recentInfo: {
        flex: 1,
        gap: 2,
    },
    recentName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '600',
    },
    recentMeta: {
        color: colors.textMuted,
        fontSize: 12,
    },
    completedActionsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: space.sm,
        marginTop: 2,
    },
    launchpadContainer: {
        gap: space.sm,
        marginTop: space.xs,
    },
    launchpadHeading: {
        color: colors.textMuted,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        paddingHorizontal: 2,
        marginBottom: 2,
    },
    launchpadGrid: {
        gap: space.sm,
    },
    quickModesBar: {
        gap: space.sm,
        marginTop: space.xs,
    },
    quickModeCard: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        padding: space.lg,
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
    },
    quickModeCardPressed: {
        backgroundColor: colors.surfacePressed,
    },
    quickModeIcon: {
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: 'center',
        justifyContent: 'center',
    },
    quickModeText: {
        flex: 1,
        minWidth: 0,
    },
    quickModeTitle: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
    },
    quickModeSubtitle: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 1,
    },
    thumbnailImg: {
        width: 38,
        height: 38,
        borderRadius: 8,
        backgroundColor: colors.surfacePressed,
        borderWidth: 1,
        borderColor: colors.borderStrong,
    },
    addMoreRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-around',
        paddingTop: space.sm,
        borderTopWidth: StyleSheet.hairlineWidth * 2,
        borderTopColor: colors.border,
    },
    commandCard: {
        borderRadius: radius.xl,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1.5,
        borderColor: colors.primaryBorder,
        padding: space.lg,
        gap: space.md,
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.15,
        shadowRadius: 16,
        elevation: 6,
    },
    commandHeader: {
        alignItems: 'center',
        gap: space.xs,
    },
    commandIconGlow: {
        width: 52,
        height: 52,
        borderRadius: 16,
        backgroundColor: colors.primarySoft,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: space.xs,
    },
    commandTitle: {
        color: colors.text,
        fontSize: 20,
        fontWeight: '800',
        letterSpacing: 0.2,
    },
    commandSubtitle: {
        color: colors.textMuted,
        fontSize: 12,
        textAlign: 'center',
        maxWidth: 280,
    },
    pickerActionsRow: {
        flexDirection: 'row',
        gap: space.sm,
    },
    pickerActionBtn: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: space.md,
        paddingHorizontal: space.xs,
        borderRadius: radius.lg,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 6,
    },
    pickerActionBtnPressed: {
        backgroundColor: colors.surfacePressed,
        borderColor: colors.primaryBorder,
        transform: [{ scale: 0.97 }],
    },
    pickerActionIcon: {
        width: 42,
        height: 42,
        borderRadius: 13,
        alignItems: 'center',
        justifyContent: 'center',
    },
    pickerActionLabel: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
    },
    pickerActionSub: {
        color: colors.textFaint,
        fontSize: 10,
        fontWeight: '500',
    },
});
