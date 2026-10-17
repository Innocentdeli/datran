import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View, TouchableOpacity, ActivityIndicator, Alert, ScrollView, TextInput } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { useState, useEffect } from 'react';
import { LinearGradient } from 'expo-linear-gradient';

import { Dashboard } from './src/components/Dashboard';
import { Inbox } from './src/components/Inbox';

// Default to local dev server
// Set your dev machine's LAN address in the app's settings field; port matches scripts/start-all.
const DEFAULT_API_URL = 'http://localhost:3001/api/ingest';

type Tab = 'upload' | 'dashboard' | 'inbox';

export default function App() {
    const [uploading, setUploading] = useState(false);
    const [lastLink, setLastLink] = useState(null);
    const [apiUrl, setApiUrl] = useState(DEFAULT_API_URL);
    const [stats, setStats] = useState(null);
    const [activeTab, setActiveTab] = useState<Tab>('upload');
    const [inboxItems, setInboxItems] = useState([]);

    const pickDocument = async () => {
        try {
            const result = await DocumentPicker.getDocumentAsync({
                type: '*/*',
                copyToCacheDirectory: true,
            });

            if (result.type === 'success') {
                uploadFile(result);
            }
        } catch (err) {
            console.log('Pick error', err);
        }
    };

    const uploadFile = async (file: any) => {
        setUploading(true);
        setStats(null);

        try {
            const formData = new FormData();
            // Declared before the file so the server can stream it and knows it may be sampled.
            formData.append('is_encrypted', 'false');
            formData.append('password', '');
            // @ts-ignore - FormData expects this structure in RN
            formData.append('file', {
                uri: file.uri,
                name: file.name,
                type: file.mimeType || 'application/octet-stream'
            });

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'multipart/form-data',
                },
                body: formData,
            });

            const data = await response.json();

            if (data.success) {
                setLastLink(data.link);
                setStats(data.stats);
                Alert.alert('Singularity Achieved', 'File has been evolved and distributed.');
                // Simulate adding to inbox for demo
                setInboxItems(prev => [
                    { id: Date.now().toString(), sender: 'SYSTEM', filename: file.name, timestamp: 'JUST NOW' },
                    ...prev
                ] as any);
            } else {
                throw new Error(data.message || 'Transmission failed');
            }

        } catch (error: any) {
            Alert.alert('Transmission Error', error.message);
        } finally {
            setUploading(false);
        }
    };

    const renderContent = () => {
        switch (activeTab) {
            case 'dashboard':
                return <Dashboard stats={stats} />;
            case 'inbox':
                return <Inbox items={inboxItems} />;
            default:
                return (
                    <>
                        <View style={styles.configCard}>
                            <Text style={styles.cardLabel}>NODE CONFIGURATION</Text>
                            <TextInput
                                style={styles.input}
                                value={apiUrl}
                                onChangeText={setApiUrl}
                                placeholder="API Endpoint"
                                placeholderTextColor="#444"
                            />
                        </View>

                        <View style={styles.mainCard}>
                            <Text style={styles.cardLabel}>INGESTION PORTAL</Text>
                            <Text style={styles.description}>
                                Select a payload for multi-dimensional compression and swarm distribution.
                            </Text>
                            
                            <TouchableOpacity
                                style={[styles.button, uploading && styles.disabled]}
                                onPress={pickDocument}
                                disabled={uploading}
                            >
                                {uploading ? (
                                    <ActivityIndicator color="#000" />
                                ) : (
                                    <Text style={styles.buttonText}>INITIATE UPLOAD</Text>
                                )}
                            </TouchableOpacity>
                        </View>

                        {lastLink && (
                            <View style={styles.resultCard}>
                                <Text style={styles.resultLabel}>TRANSMISSION SUCCESSFUL</Text>
                                <View style={styles.linkContainer}>
                                    <Text style={styles.linkText} numberOfLines={1}>{lastLink}</Text>
                                </View>
                                
                                {stats && (
                                    <View style={styles.statsGrid}>
                                        <View style={styles.statItem}>
                                            <Text style={styles.statVal}>{stats.ratio}</Text>
                                            <Text style={styles.statLabel}>RATIO</Text>
                                        </View>
                                        <View style={styles.statItem}>
                                            <Text style={styles.statVal}>{stats.speed}</Text>
                                            <Text style={styles.statLabel}>LATENCY</Text>
                                        </View>
                                        <View style={styles.statItem}>
                                            <Text style={styles.statVal}>{stats.fidelity || '99.9%'}</Text>
                                            <Text style={styles.statLabel}>FIDELITY</Text>
                                        </View>
                                    </View>
                                )}
                            </View>
                        )}
                    </>
                );
        }
    };

    return (
        <View style={styles.container}>
            <LinearGradient
                colors={['#0a0a0a', '#050505']}
                style={styles.background}
            />
            
            <ScrollView contentContainerStyle={styles.scrollContent}>
                <View style={styles.headerTitleContainer}>
                    <Text style={styles.title}>DIOCOM<Text style={styles.highlight}>//</Text>MOBILE</Text>
                    <Text style={styles.subtitle}>Autonomous Compression Swarm</Text>
                </View>

                {renderContent()}
            </ScrollView>

            <View style={styles.tabBar}>
                <TouchableOpacity 
                    style={[styles.tabItem, activeTab === 'upload' && styles.activeTab]} 
                    onPress={() => setActiveTab('upload')}
                >
                    <Text style={[styles.tabIcon, activeTab === 'upload' && styles.activeTabIcon]}>↑</Text>
                    <Text style={[styles.tabLabel, activeTab === 'upload' && styles.activeTabLabel]}>INGEST</Text>
                </TouchableOpacity>
                
                <TouchableOpacity 
                    style={[styles.tabItem, activeTab === 'dashboard' && styles.activeTab]} 
                    onPress={() => setActiveTab('dashboard')}
                >
                    <Text style={[styles.tabIcon, activeTab === 'dashboard' && styles.activeTabIcon]}>📊</Text>
                    <Text style={[styles.tabLabel, activeTab === 'dashboard' && styles.activeTabLabel]}>STATS</Text>
                </TouchableOpacity>

                <TouchableOpacity 
                    style={[styles.tabItem, activeTab === 'inbox' && styles.activeTab]} 
                    onPress={() => setActiveTab('inbox')}
                >
                    <Text style={[styles.tabIcon, activeTab === 'inbox' && styles.activeTabIcon]}>📩</Text>
                    <Text style={[styles.tabLabel, activeTab === 'inbox' && styles.activeTabLabel]}>INBOX</Text>
                </TouchableOpacity>
            </View>

            <StatusBar style="light" />
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: '#050505',
    },
    background: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
    },
    scrollContent: {
        padding: 24,
        paddingTop: 80,
        paddingBottom: 100,
    },
    headerTitleContainer: {
        marginBottom: 40,
    },
    title: {
        fontSize: 38,
        fontWeight: '900',
        color: '#fff',
        letterSpacing: -2,
    },
    // ... (other styles remain the same)
    tabBar: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: 80,
        backgroundColor: 'rgba(5,5,5,0.95)',
        flexDirection: 'row',
        borderTopWidth: 1,
        borderColor: 'rgba(255,255,255,0.05)',
        paddingBottom: 20,
    },
    tabItem: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    activeTab: {
        backgroundColor: 'rgba(0,242,255,0.03)',
    },
    tabIcon: {
        fontSize: 18,
        color: '#444',
    },
    activeTabIcon: {
        color: '#00F2FF',
    },
    tabLabel: {
        fontSize: 8,
        fontWeight: '900',
        color: '#444',
        marginTop: 4,
        letterSpacing: 1,
    },
    activeTabLabel: {
        color: '#00F2FF',
    },
});
