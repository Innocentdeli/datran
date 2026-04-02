import React from 'react';
import { StyleSheet, Text, View, FlatList, TouchableOpacity } from 'react-native';

interface InboxItem {
    id: string;
    sender: string;
    filename: string;
    timestamp: string;
}

interface InboxProps {
    items: InboxItem[];
}

export const Inbox: React.FC<InboxProps> = ({ items }) => {
    const renderItem = ({ item }: { item: InboxItem }) => (
        <TouchableOpacity style={styles.item}>
            <View style={styles.itemHeader}>
                <Text style={styles.filename}>{item.filename}</Text>
                <Text style={styles.timestamp}>{item.timestamp}</Text>
            </View>
            <Text style={styles.sender}>From: {item.sender}</Text>
        </TouchableOpacity>
    );

    return (
        <View style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>INCOMING<Text style={styles.highlight}>//</Text>FEEDS</Text>
                <Text style={styles.subtitle}>Secured Swarm Ingress</Text>
            </View>

            {items.length === 0 ? (
                <View style={styles.empty}>
                    <Text style={styles.emptyText}>No active transmissions found in swarm.</Text>
                </View>
            ) : (
                <FlatList
                    data={items}
                    renderItem={renderItem}
                    keyExtractor={item => item.id}
                    contentContainerStyle={styles.list}
                />
            )}
        </View>
    );
};

const styles = StyleSheet.create({
    container: {
        flex: 1,
    },
    header: {
        marginBottom: 24,
    },
    title: {
        fontSize: 24,
        fontWeight: '900',
        color: '#fff',
        letterSpacing: -1,
    },
    highlight: {
        color: '#00F2FF',
    },
    subtitle: {
        color: '#666',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: 2,
    },
    list: {
        paddingBottom: 20,
    },
    item: {
        backgroundColor: 'rgba(255,255,255,0.03)',
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
        marginBottom: 12,
    },
    itemHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 4,
    },
    filename: {
        color: '#fff',
        fontSize: 14,
        fontWeight: 'bold',
    },
    timestamp: {
        color: '#444',
        fontSize: 10,
    },
    sender: {
        color: '#666',
        fontSize: 12,
    },
    empty: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        paddingTop: 40,
    },
    emptyText: {
        color: '#444',
        fontSize: 14,
        textAlign: 'center',
    },
});
