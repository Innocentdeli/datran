import { useState } from 'react';
import { Linking, Share, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { colors, shared } from '../theme';

interface LinkActionsProps {
    link: string;
    filename: string;
}

/** Copy / share / open buttons for a share link. */
export function LinkActions({ link, filename }: LinkActionsProps) {
    const [note, setNote] = useState<string | null>(null);

    const copy = async () => {
        try {
            await Clipboard.setStringAsync(link);
            setNote('Link copied');
        } catch {
            setNote('Could not copy the link');
        }
    };

    const share = async () => {
        try {
            // Plain text share sheet; expo-sharing only shares local files, not URLs.
            await Share.share({ message: link, url: link, title: filename });
        } catch {
            await copy();
        }
    };

    const open = async () => {
        try {
            await Linking.openURL(link);
        } catch {
            setNote('Could not open the link');
        }
    };

    return (
        <View>
            <View style={styles.row}>
                <TouchableOpacity style={[shared.secondaryButton, styles.action]} onPress={copy} accessibilityRole="button">
                    <Text style={shared.secondaryButtonText}>Copy</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[shared.secondaryButton, styles.action]} onPress={share} accessibilityRole="button">
                    <Text style={shared.secondaryButtonText}>Share</Text>
                </TouchableOpacity>
                <TouchableOpacity style={[shared.secondaryButton, styles.action]} onPress={open} accessibilityRole="link">
                    <Text style={shared.secondaryButtonText}>Open</Text>
                </TouchableOpacity>
            </View>
            {note ? <Text style={styles.note}>{note}</Text> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    row: {
        flexDirection: 'row',
        gap: 8,
    },
    action: {
        flex: 1,
        paddingVertical: 10,
    },
    note: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 8,
    },
});
