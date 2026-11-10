import { Linking, Share, StyleSheet, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { space } from '../theme';
import { Button, IconButton, useToast } from '../ui';

interface LinkActionsProps {
    link: string;
    filename: string;
    /** `full` = labelled buttons (success screen); `compact` = icon buttons (list rows). */
    variant?: 'full' | 'compact';
}

/** Copy / share / open for a share link. Feedback goes through the global toast. */
export function LinkActions({ link, filename, variant = 'full' }: LinkActionsProps) {
    const toast = useToast();

    const copy = async () => {
        try {
            await Clipboard.setStringAsync(link);
            toast.show('Link copied to clipboard');
        } catch {
            toast.show('Could not copy the link', 'error');
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
            toast.show('Could not open the link', 'error');
        }
    };

    if (variant === 'compact') {
        return (
            <View style={styles.compact}>
                <IconButton icon="copy-outline" label={`Copy link for ${filename}`} onPress={copy} size={36} />
                <IconButton icon="share-outline" label={`Share ${filename}`} onPress={share} size={36} />
            </View>
        );
    }

    return (
        <View style={styles.full}>
            <Button label="Copy link" icon="copy-outline" onPress={copy} size="lg" fullWidth />
            <View style={styles.row}>
                <Button label="Share" icon="share-outline" variant="secondary" onPress={share} style={styles.flex} fullWidth />
                <Button label="Open" icon="open-outline" variant="secondary" onPress={open} accessibilityRole="link" style={styles.flex} fullWidth />
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    full: { gap: space.sm },
    row: { flexDirection: 'row', gap: space.sm },
    flex: { flex: 1 },
    compact: { flexDirection: 'row', gap: space.sm },
});
