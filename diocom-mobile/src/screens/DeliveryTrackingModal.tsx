import React, { useEffect, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { colors, radius, space, type } from '../theme';
import { Badge, Button, IconButton, haptic, useToast } from '../ui';
import { fetchDeliveryTracking, type DeliveryTrackingResponse } from '../api/client';

interface DeliveryTrackingModalProps {
    visible: boolean;
    fileId: string;
    fileName: string;
    serverUrl: string;
    onClose: () => void;
}

export function DeliveryTrackingModal({
    visible,
    fileId,
    fileName,
    serverUrl,
    onClose,
}: DeliveryTrackingModalProps) {
    const toast = useToast();
    const [loading, setLoading] = useState(true);
    const [tracking, setTracking] = useState<DeliveryTrackingResponse | null>(null);

    useEffect(() => {
        if (!visible || !fileId) return;
        let isMounted = true;
        setLoading(true);
        fetchDeliveryTracking(serverUrl, fileId)
            .then((data) => {
                if (isMounted) setTracking(data);
            })
            .catch((err) => {
                if (isMounted) toast.show(err.message || 'Failed to load tracking data', 'error');
            })
            .finally(() => {
                if (isMounted) setLoading(false);
            });

        return () => {
            isMounted = false;
        };
    }, [visible, fileId, serverUrl]);

    if (!visible) return null;

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            <View style={styles.backdrop}>
                <View style={styles.sheet}>
                    <View style={styles.header}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.title}>Delivery Tracking</Text>
                            <Text style={styles.subtitle} numberOfLines={1}>{fileName}</Text>
                        </View>
                        <IconButton icon="close-outline" label="Close" size={36} onPress={onClose} />
                    </View>

                    <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
                        {loading ? (
                            <View style={styles.center}>
                                <ActivityIndicator size="large" color={colors.primary} />
                                <Text style={styles.loadingText}>Fetching delivery status...</Text>
                            </View>
                        ) : !tracking || tracking.recipients.length === 0 ? (
                            <View style={styles.empty}>
                                <Text style={styles.emptyTitle}>No Email Recipients</Text>
                                <Text style={styles.emptySub}>
                                    This transfer has not been sent via email yet, or was shared via direct link.
                                </Text>
                            </View>
                        ) : (
                            <View style={{ gap: space.md }}>
                                {tracking.require_email_otp && (
                                    <View style={styles.banner}>
                                        <Text style={styles.bannerText}>
                                            🔒 Protected: Recipients must enter an email security code before accessing files.
                                        </Text>
                                    </View>
                                )}

                                {tracking.recipients.map((r) => (
                                    <View key={r.id} style={styles.recipientCard}>
                                        <View style={styles.recipientTop}>
                                            <Text style={styles.emailText} numberOfLines={1}>
                                                {r.recipient_email}
                                            </Text>
                                            <Badge
                                                label={r.status.toUpperCase()}
                                                tone={
                                                    r.status === 'downloaded'
                                                        ? 'success'
                                                        : r.status === 'opened'
                                                        ? 'primary'
                                                        : 'neutral'
                                                }
                                            />
                                        </View>
                                        <View style={styles.timeline}>
                                            <Text style={styles.timelineText}>
                                                • Sent: {new Date(r.sent_at).toLocaleString()}
                                            </Text>
                                            {r.opened_at && (
                                                <Text style={styles.timelineText}>
                                                    • Viewed: {new Date(r.opened_at).toLocaleString()}
                                                </Text>
                                            )}
                                            {r.downloaded_at && (
                                                <Text style={styles.timelineText}>
                                                    • Downloaded: {new Date(r.downloaded_at).toLocaleString()}
                                                </Text>
                                            )}
                                        </View>
                                    </View>
                                ))}
                            </View>
                        )}
                    </ScrollView>
                </View>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
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
        maxHeight: '85%',
        paddingBottom: space.xl,
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
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
    subtitle: {
        ...type.caption,
        color: colors.textMuted,
        marginTop: 2,
    },
    content: {
        padding: space.lg,
    },
    center: {
        paddingVertical: space.xl * 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
    loadingText: {
        ...type.body,
        color: colors.textMuted,
        marginTop: space.md,
    },
    empty: {
        paddingVertical: space.xl,
        alignItems: 'center',
    },
    emptyTitle: {
        ...type.headline,
        color: colors.text,
        marginBottom: space.xs,
    },
    emptySub: {
        ...type.body,
        color: colors.textMuted,
        textAlign: 'center',
    },
    banner: {
        backgroundColor: colors.primarySoft,
        borderRadius: radius.md,
        padding: space.md,
        borderWidth: 1,
        borderColor: colors.primary,
    },
    bannerText: {
        ...type.caption,
        color: colors.primary,
    },
    recipientCard: {
        backgroundColor: colors.background,
        borderRadius: radius.md,
        padding: space.md,
        borderWidth: 1,
        borderColor: colors.border,
    },
    recipientTop: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: space.sm,
    },
    emailText: {
        ...type.body,
        fontWeight: '600',
        color: colors.text,
        flex: 1,
        marginRight: space.sm,
    },
    timeline: {
        gap: 4,
    },
    timelineText: {
        ...type.caption,
        color: colors.textMuted,
    },
});
