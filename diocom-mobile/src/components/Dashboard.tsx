import React from 'react';
import { StyleSheet, Text, View, ScrollView } from 'react-native';

interface DashboardProps {
    stats: any;
}

export const Dashboard: React.FC<DashboardProps> = ({ stats }) => {
    return (
        <ScrollView style={styles.container}>
            <View style={styles.header}>
                <Text style={styles.title}>SYSTEM<Text style={styles.highlight}>//</Text>METRICS</Text>
                <Text style={styles.subtitle}>Real-time Node Status</Text>
            </View>

            <View style={styles.grid}>
                <View style={styles.statBox}>
                    <Text style={styles.statVal}>{stats?.ratio || '1.0x'}</Text>
                    <Text style={styles.statLabel}>AVG RATIO</Text>
                </View>
                <View style={styles.statBox}>
                    <Text style={styles.statVal}>{stats?.speed || 'Low'}</Text>
                    <Text style={styles.statLabel}>LATENCY</Text>
                </View>
                <View style={styles.statBox}>
                    <Text style={styles.statVal}>Active</Text>
                    <Text style={styles.statLabel}>SWARM STATUS</Text>
                </View>
                <View style={styles.statBox}>
                    <Text style={styles.statVal}>99.9%</Text>
                    <Text style={styles.statLabel}>FIDELITY</Text>
                </View>
            </View>

            <View style={styles.infoCard}>
                <Text style={styles.cardTitle}>ACS NODE HEALTH</Text>
                <View style={styles.healthBar}>
                    <View style={[styles.healthFill, { width: '85%' }]} />
                </View>
                <Text style={styles.healthText}>85% Evolutionary Fitness</Text>
            </View>
        </ScrollView>
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
    grid: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        marginHorizontal: -8,
    },
    statBox: {
        width: '50%',
        padding: 8,
    },
    statVal: {
        color: '#fff',
        fontSize: 20,
        fontWeight: 'bold',
        backgroundColor: 'rgba(255,255,255,0.05)',
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
        textAlign: 'center',
    },
    statLabel: {
        color: '#444',
        fontSize: 8,
        fontWeight: '900',
        marginTop: 4,
        textAlign: 'center',
    },
    infoCard: {
        marginTop: 24,
        backgroundColor: 'rgba(0,242,255,0.05)',
        padding: 20,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: 'rgba(0,242,255,0.1)',
    },
    cardTitle: {
        color: '#00F2FF',
        fontSize: 10,
        fontWeight: 'bold',
        marginBottom: 12,
    },
    healthBar: {
        height: 4,
        backgroundColor: 'rgba(255,255,255,0.1)',
        borderRadius: 2,
        marginBottom: 8,
    },
    healthFill: {
        height: '100%',
        backgroundColor: '#00F2FF',
        borderRadius: 2,
    },
    healthText: {
        color: '#aaa',
        fontSize: 12,
    },
});
