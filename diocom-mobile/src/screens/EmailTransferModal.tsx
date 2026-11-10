import React, { useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import { colors, radius, space, type } from '../theme';
import { Button, IconButton, SwitchRow, TextField, haptic, useToast } from '../ui';
import { sendTransferEmail } from '../api/client';

interface EmailTransferModalProps {
    visible: boolean;
    fileId: string;
    fileName: string;
    link?: string;
    serverUrl: string;
    onClose: () => void;
}

export function EmailTransferModal({
    visible,
    fileId,
    fileName,
    link,
    serverUrl,
    onClose,
}: EmailTransferModalProps) {
    const toast = useToast();
    const [emails, setEmails] = useState('');
    const [message, setMessage] = useState('');
    const [requireOtp, setRequireOtp] = useState(false);
    const [sending, setSending] = useState(false);

    if (!visible) return null;

    const handleSend = async () => {
        const emailList = emails
            .split(/[\n,;]+/)
            .map((e) => e.trim().toLowerCase())
            .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));

        if (emailList.length === 0) {
            haptic.warning();
            toast.show('Please enter at least one valid email address', 'error');
            return;
        }

        setSending(true);
        try {
            await sendTransferEmail(serverUrl, fileId, {
                recipients: emailList,
                message: message.trim() || undefined,
                requireOtp,
                link,
            });
            haptic.success();
            toast.show(`Sent to ${emailList.length} recipient${emailList.length > 1 ? 's' : ''}`);
            onClose();
        } catch (err: any) {
            haptic.error();
            toast.show(err.message || 'Failed to send transfer email', 'error');
        } finally {
            setSending(false);
        }
    };

    return (
        <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
            <View style={styles.backdrop}>
                <View style={styles.sheet}>
                    <View style={styles.header}>
                        <View style={{ flex: 1 }}>
                            <Text style={styles.title}>Send by Email</Text>
                            <Text style={styles.subtitle} numberOfLines={1}>{fileName}</Text>
                        </View>
                        <IconButton icon="close-outline" label="Close" size={36} onPress={onClose} />
                    </View>

                    <ScrollView style={styles.content} keyboardShouldPersistTaps="handled">
                        <TextField
                            label="RECIPIENTS"
                            placeholder="colleague@company.com, client@firm.com"
                            value={emails}
                            onChangeText={setEmails}
                            autoCapitalize="none"
                            keyboardType="email-address"
                            hint="Separate multiple emails with commas."
                        />

                        <View style={{ height: space.md }} />

                        <TextField
                            label="PERSONAL MESSAGE (OPTIONAL)"
                            placeholder="Add a message for your recipients..."
                            value={message}
                            onChangeText={setMessage}
                            multiline
                            numberOfLines={3}
                        />

                        <View style={{ height: space.md }} />

                        <SwitchRow
                            icon="shield-checkmark-outline"
                            title="Require Email Verification (OTP)"
                            subtitle="Recipients must verify a 6-digit code sent to their email to unlock the download."
                            value={requireOtp}
                            onChange={setRequireOtp}
                        />

                        <View style={{ height: space.lg }} />

                        <Button
                            label={sending ? 'Sending...' : 'Send Transfer'}
                            icon="paper-plane"
                            variant="primary"
                            size="lg"
                            fullWidth
                            disabled={sending}
                            onPress={handleSend}
                        />
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
        maxHeight: '90%',
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
});
