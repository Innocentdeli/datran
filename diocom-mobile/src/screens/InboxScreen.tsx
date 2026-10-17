import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

import { LinkActions } from '../components/LinkActions';
import type { HistoryItem } from '../storage/history';
import { colors, formatBytes, shared } from '../theme';

interface InboxScreenProps {
    items: HistoryItem[];
    onRemove: (id: string) => void;
    onClear: () => void;
}

/**
 * Uploads made from this device, persisted in AsyncStorage. Once the server offers token auth this screen can
 * also list the signed-in user's files from the server; until then only local history is available.
 */
export function InboxScreen({ items, onRemove, onClear }: InboxScreenProps) {
    return (
        <View>
            <Text style={shared.screenTitle}>
                MY<Text style={{ color: colors.accent }}>{'//'}</Text>UPLOADS
            </Text>
            <Text style={shared.screenSubtitle}>Uploaded from this device</Text>

            {items.length === 0 ? (
                <View style={shared.card}>
                    <Text style={shared.body}>No uploads yet. Files you upload appear here with their share links.</Text>
                </View>
            ) : (
                <>
                    {items.map((item) => (
                        <View key={item.id} style={shared.card}>
                            <View style={styles.header}>
                                <Text style={styles.filename} numberOfLines={1}>
                                    {item.filename}
                                </Text>
                                <TouchableOpacity
                                    onPress={() => onRemove(item.id)}
                                    accessibilityRole="button"
                                    accessibilityLabel={`Remove ${item.filename} from history`}
                                    hitSlop={8}
                                >
                                    <Text style={styles.remove}>Remove</Text>
                                </TouchableOpacity>
                            </View>
                            <Text style={styles.meta}>
                                {formatBytes(item.size)} · {new Date(item.uploadedAt).toLocaleString()}
                                {item.stats?.ratio ? ` · ${item.stats.ratio}` : ''}
                            </Text>
                            <Text style={styles.link} selectable numberOfLines={1}>
                                {item.link}
                            </Text>
                            <LinkActions link={item.link} filename={item.filename} />
                        </View>
                    ))}
                    <TouchableOpacity style={shared.secondaryButton} onPress={onClear} accessibilityRole="button">
                        <Text style={[shared.secondaryButtonText, { color: colors.danger }]}>Clear history</Text>
                    </TouchableOpacity>
                    <Text style={styles.footnote}>
                        Removing an entry only forgets it on this device; the file and its link stay on the server until
                        they expire.
                    </Text>
                </>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    filename: {
        color: colors.text,
        fontSize: 15,
        fontWeight: '700',
        flex: 1,
    },
    remove: {
        color: colors.textFaint,
        fontSize: 12,
    },
    meta: {
        color: colors.textMuted,
        fontSize: 12,
        marginTop: 4,
    },
    link: {
        color: colors.accent,
        fontSize: 13,
        marginVertical: 10,
    },
    footnote: {
        color: colors.textFaint,
        fontSize: 12,
        lineHeight: 17,
        marginTop: 12,
        textAlign: 'center',
    },
});
