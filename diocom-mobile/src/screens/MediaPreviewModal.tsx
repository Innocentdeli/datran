import { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Image,
    Linking,
    Modal,
    Pressable,
    ScrollView,
    Share,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { colors, formatBytes, formatRelativeTime, radius, space } from '../theme';
import { Badge, Button, FileIcon, haptic, Icon, IconButton, useToast } from '../ui';
import { fetchFileReviews, type ReviewItem, type ReviewCommentItem } from '../api/client';
import { DEFAULT_SETTINGS } from '../storage/settings';
import { EmailTransferModal } from './EmailTransferModal';
import { DeliveryTrackingModal } from './DeliveryTrackingModal';

export interface PreviewableFile {
    id?: string;
    filename: string;
    size: number;
    link: string;
    mimeType?: string;
    serverUrl?: string;
    uploadedAt?: number;
    stats?: {
        originalSize?: number;
        compressedSize?: number;
        ratio?: string;
    };
}

interface MediaPreviewModalProps {
    visible: boolean;
    file: PreviewableFile | null;
    signedIn?: boolean;
    serverUrl?: string;
    onClose: () => void;
    onSendToUser?: (item: { shareId: string; filename: string }) => void;
}

export function MediaPreviewModal({
    visible,
    file,
    signedIn = false,
    serverUrl = DEFAULT_SETTINGS.serverUrl,
    onClose,
    onSendToUser,
}: MediaPreviewModalProps) {
    const toast = useToast();
    const [imageLoading, setImageLoading] = useState(true);
    const [isPlayingAudio, setIsPlayingAudio] = useState(false);
    const [emailModalOpen, setEmailModalOpen] = useState(false);
    const [trackingModalOpen, setTrackingModalOpen] = useState(false);
    const [showReviewsSheet, setShowReviewsSheet] = useState(false);
    const [reviews, setReviews] = useState<ReviewItem[]>([]);
    const [comments, setComments] = useState<ReviewCommentItem[]>([]);

    const fileId = file?.id || file?.link?.split('/').pop() || '';

    useEffect(() => {
        if (!visible || !fileId) return;
        fetchFileReviews(serverUrl, fileId)
            .then((res) => {
                setReviews(res.reviews || []);
                setComments(res.comments || []);
            })
            .catch(() => {
                // Non-critical, ignore if no reviews
            });
    }, [visible, fileId, serverUrl]);

    if (!file) return null;

    const ext = file.filename.split('.').pop()?.toLowerCase() || '';
    const isImage =
        Boolean(file.mimeType?.startsWith('image/')) ||
        ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext);
    const isVideo =
        Boolean(file.mimeType?.startsWith('video/')) ||
        ['mp4', 'mov', 'webm', 'mkv', 'avi'].includes(ext);
    const isAudio =
        Boolean(file.mimeType?.startsWith('audio/')) ||
        ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg'].includes(ext);
    const isDocument = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv'].includes(ext);
    const isCode = ['js', 'ts', 'tsx', 'jsx', 'json', 'py', 'rs', 'html', 'css', 'md', 'txt', 'sql'].includes(ext);

    // Direct download/stream URL
    const rawDirectUrl = `${file.link.replace(/\/+$/, '')}/raw`;

    const approvedCount = reviews.filter((r) => r.status === 'approved').length;
    const changesCount = reviews.filter((r) => r.status === 'changes_requested').length;

    const handleCopyLink = async () => {
        haptic.light();
        await Clipboard.setStringAsync(file.link);
        toast.show('Share link copied to clipboard');
    };

    const handleSystemShare = async () => {
        haptic.tap();
        try {
            await Share.share({
                title: file.filename,
                message: `Download "${file.filename}" via Datran: ${file.link}`,
                url: file.link,
            });
        } catch {
            // Ignored if cancelled
        }
    };

    const handleOpenInBrowser = async () => {
        haptic.tap();
        try {
            await Linking.openURL(file.link);
        } catch (err) {
            toast.show(`Could not open browser: ${err instanceof Error ? err.message : String(err)}`, 'error');
        }
    };

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            <View style={styles.backdrop}>
                <View style={styles.container}>
                    {/* MODAL HEADER */}
                    <View style={styles.header}>
                        <View style={styles.headerLeft}>
                            <View style={styles.kindBadge}>
                                <Icon
                                    name={
                                        isImage
                                            ? 'image'
                                            : isVideo
                                              ? 'videocam'
                                              : isAudio
                                                ? 'musical-notes'
                                                : isCode
                                                  ? 'code-slash'
                                                  : 'document-text'
                                    }
                                    size={16}
                                    color={colors.primary}
                                />
                            </View>
                            <View style={styles.headerTitleWrap}>
                                <Text style={styles.filename} numberOfLines={1}>
                                    {file.filename}
                                </Text>
                                <Text style={styles.subTitle}>
                                    {formatBytes(file.size)}
                                    {file.uploadedAt ? ` · ${formatRelativeTime(file.uploadedAt)}` : ''}
                                </Text>
                            </View>
                        </View>
                        <IconButton icon="close" label="Close preview" size={36} onPress={onClose} />
                    </View>

                    {/* PREVIEW VIEWPORT */}
                    <View style={styles.viewport}>
                        {isImage ? (
                            <View style={styles.imageBox}>
                                {imageLoading ? (
                                    <View style={styles.loaderCenter}>
                                        <ActivityIndicator size="large" color={colors.primary} />
                                        <Text style={styles.loaderText}>Loading preview...</Text>
                                    </View>
                                ) : null}
                                <Image
                                    source={{ uri: rawDirectUrl }}
                                    style={styles.image}
                                    resizeMode="contain"
                                    onLoadEnd={() => setImageLoading(false)}
                                    onError={() => setImageLoading(false)}
                                />
                            </View>
                        ) : isVideo ? (
                            <View style={styles.mediaBox}>
                                <View style={styles.videoPlaceholder}>
                                    <View style={styles.playButtonWrap}>
                                        <Icon name="play" size={36} color={colors.primary} />
                                    </View>
                                    <Text style={styles.mediaTitle}>OmniPlayer Stream Ready</Text>
                                    <Text style={styles.mediaSub}>
                                        Stream-on-demand enabled · Tap below to play stream
                                    </Text>
                                </View>
                            </View>
                        ) : isAudio ? (
                            <View style={styles.mediaBox}>
                                <View style={styles.audioCard}>
                                    <View style={styles.waveformRow}>
                                        {[24, 48, 36, 72, 60, 84, 40, 68, 52, 92, 38, 70, 44, 80, 56, 30].map(
                                            (h, i) => (
                                                <View
                                                    key={i}
                                                    style={[
                                                        styles.waveBar,
                                                        {
                                                            height: h * 0.45,
                                                            backgroundColor:
                                                                isPlayingAudio && i % 2 === 0
                                                                    ? colors.primary
                                                                    : colors.borderStrong,
                                                        },
                                                    ]}
                                                />
                                            )
                                        )}
                                    </View>
                                    <Pressable
                                        onPress={() => {
                                            haptic.medium();
                                            setIsPlayingAudio(!isPlayingAudio);
                                        }}
                                        style={styles.audioPlayButton}
                                    >
                                        <Icon
                                            name={isPlayingAudio ? 'pause' : 'play'}
                                            size={22}
                                            color={colors.onPrimary}
                                        />
                                        <Text style={styles.audioPlayText}>
                                            {isPlayingAudio ? 'Pause Audio' : 'Preview Audio'}
                                        </Text>
                                    </Pressable>
                                </View>
                            </View>
                        ) : (
                            <ScrollView contentContainerStyle={styles.docBox} showsVerticalScrollIndicator={false}>
                                <FileIcon name={file.filename} mime={file.mimeType} size={64} />
                                <Text style={styles.docTitle}>{file.filename}</Text>
                                <View style={styles.metadataCard}>
                                    <View style={styles.metaRow}>
                                        <Text style={styles.metaKey}>File Size</Text>
                                        <Text style={styles.metaVal}>{formatBytes(file.size)}</Text>
                                    </View>
                                    <View style={styles.metaRow}>
                                        <Text style={styles.metaKey}>Format</Text>
                                        <Text style={styles.metaVal}>{ext.toUpperCase() || 'Binary'}</Text>
                                    </View>
                                    <View style={styles.metaRow}>
                                        <Text style={styles.metaKey}>Security</Text>
                                        <Text style={[styles.metaVal, { color: colors.success }]}>
                                            AES-256-GCM Zero-Knowledge
                                        </Text>
                                    </View>
                                    {file.stats?.ratio ? (
                                        <View style={styles.metaRow}>
                                            <Text style={styles.metaKey}>ACS Compression</Text>
                                            <Text style={[styles.metaVal, { color: colors.primary }]}>
                                                {file.stats.ratio} savings
                                            </Text>
                                        </View>
                                    ) : null}
                                </View>
                            </ScrollView>
                        )}
                    </View>

                    {/* REVIEW & APPROVAL STATUS BANNER */}
                    {(reviews.length > 0 || comments.length > 0) && (
                        <Pressable 
                            style={styles.reviewBanner}
                            onPress={() => setShowReviewsSheet(true)}
                        >
                            <View style={styles.reviewBannerLeft}>
                                <Icon
                                    name={approvedCount > 0 ? 'checkmark-circle' : changesCount > 0 ? 'alert-circle' : 'chatbubbles'}
                                    size={18}
                                    color={approvedCount > 0 ? colors.success : changesCount > 0 ? colors.warning : colors.primary}
                                />
                                <View>
                                    <Text style={styles.reviewBannerTitle}>
                                        {approvedCount > 0
                                            ? 'Client Approved'
                                            : changesCount > 0
                                            ? 'Changes Requested'
                                            : `${comments.length} Feedback Comment${comments.length === 1 ? '' : 's'}`}
                                    </Text>
                                    <Text style={styles.reviewBannerSubtitle}>
                                        {comments.length > 0 ? `${comments.length} comments · Tap to read` : 'Tap to view review'}
                                    </Text>
                                </View>
                            </View>
                            <Badge
                                label={approvedCount > 0 ? 'APPROVED' : changesCount > 0 ? 'CHANGES' : 'FEEDBACK'}
                                tone={approvedCount > 0 ? 'success' : changesCount > 0 ? 'warning' : 'primary'}
                            />
                        </Pressable>
                    )}

                    {/* BOTTOM ACTION TOOLBAR */}
                    <View style={styles.footer}>
                        <View style={styles.primaryActionsRow}>
                            <Button
                                label="Download / Open"
                                icon="cloud-download-outline"
                                variant="primary"
                                size="md"
                                style={{ flex: 1 }}
                                onPress={handleOpenInBrowser}
                            />
                            <IconButton
                                icon="share-social-outline"
                                label="Share file"
                                size={44}
                                onPress={handleSystemShare}
                            />
                            <IconButton
                                icon="copy-outline"
                                label="Copy link"
                                size={44}
                                onPress={handleCopyLink}
                            />
                        </View>

                        <View style={styles.secondaryActionsRow}>
                            <Button
                                label="Send via Email"
                                icon="mail-outline"
                                variant="tonal"
                                size="sm"
                                style={{ flex: 1 }}
                                onPress={() => setEmailModalOpen(true)}
                            />
                            <Button
                                label="Delivery Tracking"
                                icon="stats-chart-outline"
                                variant="tonal"
                                size="sm"
                                style={{ flex: 1 }}
                                onPress={() => setTrackingModalOpen(true)}
                            />
                        </View>

                        {signedIn && onSendToUser ? (
                            <Button
                                label="Send to @User Directly"
                                icon="paper-plane"
                                variant="ghost"
                                size="sm"
                                fullWidth
                                onPress={() => {
                                    const shareId = file.link.split('/').pop() || file.id || '';
                                    onClose();
                                    onSendToUser({ shareId, filename: file.filename });
                                }}
                            />
                        ) : null}
                    </View>
                </View>

                {/* EMAIL TRANSFER MODAL */}
                <EmailTransferModal
                    visible={emailModalOpen}
                    fileId={fileId}
                    fileName={file.filename}
                    link={file.link}
                    serverUrl={serverUrl}
                    onClose={() => setEmailModalOpen(false)}
                />

                {/* DELIVERY TRACKING MODAL */}
                <DeliveryTrackingModal
                    visible={trackingModalOpen}
                    fileId={fileId}
                    fileName={file.filename}
                    serverUrl={serverUrl}
                    onClose={() => setTrackingModalOpen(false)}
                />

                {/* REVIEWS SHEET MODAL */}
                <Modal
                    visible={showReviewsSheet}
                    animationType="slide"
                    transparent
                    onRequestClose={() => setShowReviewsSheet(false)}
                >
                    <View style={styles.backdrop}>
                        <View style={[styles.container, { height: '65%' }]}>
                            <View style={styles.header}>
                                <Text style={styles.sheetTitle}>Review & Feedback</Text>
                                <IconButton icon="close" label="Close" size={32} onPress={() => setShowReviewsSheet(false)} />
                            </View>
                            <ScrollView contentContainerStyle={{ padding: space.lg, gap: space.md }}>
                                {reviews.map((r) => (
                                    <View key={r.id} style={styles.reviewCard}>
                                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <Text style={styles.reviewerName}>{r.reviewer_name || 'Reviewer'}</Text>
                                            <Badge
                                                label={r.status === 'approved' ? 'APPROVED' : 'CHANGES REQUESTED'}
                                                tone={r.status === 'approved' ? 'success' : 'warning'}
                                            />
                                        </View>
                                        {r.decision_note ? <Text style={styles.reviewNotes}>{r.decision_note}</Text> : null}
                                    </View>
                                ))}
                                {comments.map((c) => (
                                    <View key={c.id} style={styles.commentCard}>
                                        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                                            <Text style={styles.commentAuthor}>{c.reviewer_name}</Text>
                                            {c.timestamp != null ? (
                                                <Badge
                                                    label={`${Math.floor(c.timestamp / 60)}:${(c.timestamp % 60).toString().padStart(2, '0')}`}
                                                    tone="primary"
                                                />
                                            ) : null}
                                        </View>
                                        <Text style={styles.commentBody}>{c.comment}</Text>
                                    </View>
                                ))}
                            </ScrollView>
                        </View>
                    </View>
                </Modal>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    backdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.85)',
        justifyContent: 'flex-end',
    },
    container: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        height: '84%',
        display: 'flex',
        flexDirection: 'column',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.md,
        borderBottomWidth: StyleSheet.hairlineWidth * 2,
        borderBottomColor: colors.border,
    },
    headerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        flex: 1,
        marginRight: 8,
    },
    kindBadge: {
        width: 36,
        height: 36,
        borderRadius: 10,
        backgroundColor: colors.primarySoft,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
    },
    headerTitleWrap: {
        flex: 1,
    },
    filename: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
    },
    subTitle: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 2,
    },
    viewport: {
        flex: 1,
        backgroundColor: '#04070c',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
    },
    imageBox: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
    },
    image: {
        width: '92%',
        height: '92%',
    },
    loaderCenter: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: 'center',
        justifyContent: 'center',
        gap: 8,
        backgroundColor: 'rgba(4,7,12,0.8)',
        zIndex: 2,
    },
    loaderText: {
        color: colors.textMuted,
        fontSize: 12,
        fontWeight: '600',
    },
    mediaBox: {
        width: '100%',
        height: '100%',
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.xl,
    },
    videoPlaceholder: {
        width: '100%',
        height: 240,
        borderRadius: radius.lg,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
        gap: space.sm,
    },
    playButtonWrap: {
        width: 68,
        height: 68,
        borderRadius: 34,
        backgroundColor: colors.primarySoft,
        borderWidth: 1.5,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
    },
    mediaTitle: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '700',
        marginTop: 4,
    },
    mediaSub: {
        color: colors.textFaint,
        fontSize: 12,
        textAlign: 'center',
        paddingHorizontal: space.lg,
    },
    audioCard: {
        width: '100%',
        padding: space.xl,
        borderRadius: radius.xl,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        alignItems: 'center',
        gap: space.lg,
    },
    waveformRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        height: 60,
    },
    waveBar: {
        width: 5,
        borderRadius: 3,
    },
    audioPlayButton: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        backgroundColor: colors.primary,
        paddingHorizontal: space.xl,
        paddingVertical: space.md,
        borderRadius: radius.pill,
    },
    audioPlayText: {
        color: colors.onPrimary,
        fontSize: 14,
        fontWeight: '800',
        letterSpacing: 0.3,
    },
    docBox: {
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.xxl,
        width: '100%',
        gap: space.md,
    },
    docTitle: {
        color: colors.text,
        fontSize: 18,
        fontWeight: '700',
        textAlign: 'center',
    },
    metadataCard: {
        width: '100%',
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.lg,
        borderWidth: 1,
        borderColor: colors.border,
        padding: space.md,
        gap: space.sm,
        marginTop: space.sm,
    },
    metaRow: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: 4,
    },
    metaKey: {
        color: colors.textMuted,
        fontSize: 13,
    },
    metaVal: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '600',
    },
    footer: {
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        borderTopWidth: StyleSheet.hairlineWidth * 2,
        borderTopColor: colors.border,
        gap: space.sm,
    },
    primaryActionsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    secondaryActionsRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
    },
    reviewBanner: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        backgroundColor: colors.surfaceRaised,
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        borderTopWidth: 1,
        borderTopColor: colors.border,
    },
    reviewBannerLeft: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        flex: 1,
    },
    reviewBannerTitle: {
        color: colors.text,
        fontSize: 13,
        fontWeight: '700',
    },
    reviewBannerSubtitle: {
        color: colors.textMuted,
        fontSize: 11,
        marginTop: 1,
    },
    sheetTitle: {
        color: colors.text,
        fontSize: 17,
        fontWeight: '700',
    },
    reviewCard: {
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.md,
        padding: space.md,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 6,
    },
    reviewerName: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
    },
    reviewNotes: {
        color: colors.textMuted,
        fontSize: 13,
        marginTop: 2,
    },
    commentCard: {
        backgroundColor: colors.surfaceRaised,
        borderRadius: radius.md,
        padding: space.md,
        borderWidth: 1,
        borderColor: colors.border,
        gap: 4,
    },
    commentAuthor: {
        color: colors.primary,
        fontSize: 13,
        fontWeight: '700',
    },
    commentBody: {
        color: colors.text,
        fontSize: 13,
        lineHeight: 18,
    },
});
