import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';

import { getAccessToken } from './src/auth/session';
import { InboxScreen } from './src/screens/InboxScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { UploadScreen } from './src/screens/UploadScreen';
import { addHistoryItem, loadHistory, saveHistory, type HistoryItem } from './src/storage/history';
import { loadSettings, saveSettings, type Settings } from './src/storage/settings';
import { colors } from './src/theme';

type Tab = 'upload' | 'inbox' | 'settings';

const TABS: readonly { key: Tab; icon: string; label: string }[] = [
    { key: 'upload', icon: '↑', label: 'UPLOAD' },
    { key: 'inbox', icon: '☰', label: 'MY UPLOADS' },
    { key: 'settings', icon: '⚙', label: 'SETTINGS' },
];

export default function App() {
    return (
        <SafeAreaProvider>
            <Main />
            <StatusBar style="light" />
        </SafeAreaProvider>
    );
}

function Main() {
    const insets = useSafeAreaInsets();
    const [activeTab, setActiveTab] = useState<Tab>('upload');
    const [settings, setSettings] = useState<Settings | null>(null);
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [signedIn, setSignedIn] = useState(false);

    useEffect(() => {
        let alive = true;
        void Promise.all([loadSettings(), loadHistory(), getAccessToken()]).then(([s, h, token]) => {
            if (!alive) return;
            setSettings(s);
            setHistory(h);
            setSignedIn(token !== null);
        });
        return () => {
            alive = false;
        };
    }, []);

    const updateHistory = useCallback((update: (items: HistoryItem[]) => HistoryItem[]) => {
        setHistory((prev) => {
            const next = update(prev);
            saveHistory(next).catch((err: unknown) => console.warn('Failed to persist upload history', err));
            return next;
        });
    }, []);

    const handleSaveSettings = useCallback(async (next: Settings) => {
        await saveSettings(next);
        setSettings(next);
    }, []);

    if (!settings) {
        return (
            <View style={[styles.container, styles.center]}>
                <ActivityIndicator color={colors.accent} />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#0d0d0d', colors.background]} style={StyleSheet.absoluteFill} />

            <ScrollView
                contentContainerStyle={[styles.scrollContent, { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 100 }]}
                keyboardShouldPersistTaps="handled"
            >
                {activeTab === 'upload' ? (
                    <UploadScreen
                        settings={settings}
                        signedIn={signedIn}
                        onUploaded={(item) => updateHistory((items) => addHistoryItem(items, item))}
                        onOpenSettings={() => setActiveTab('settings')}
                    />
                ) : null}
                {activeTab === 'inbox' ? (
                    <InboxScreen
                        items={history}
                        onRemove={(id) => updateHistory((items) => items.filter((i) => i.id !== id))}
                        onClear={() => updateHistory(() => [])}
                    />
                ) : null}
                {activeTab === 'settings' ? (
                    <SettingsScreen settings={settings} signedIn={signedIn} onSave={handleSaveSettings} />
                ) : null}
            </ScrollView>

            <View style={[styles.tabBar, { paddingBottom: insets.bottom + 8 }]} accessibilityRole="tablist">
                {TABS.map((tab) => {
                    const active = tab.key === activeTab;
                    return (
                        <TouchableOpacity
                            key={tab.key}
                            style={[styles.tabItem, active && styles.activeTab]}
                            onPress={() => setActiveTab(tab.key)}
                            accessibilityRole="tab"
                            accessibilityState={{ selected: active }}
                            accessibilityLabel={tab.label}
                        >
                            <Text style={[styles.tabIcon, active && styles.activeText]}>{tab.icon}</Text>
                            <Text style={[styles.tabLabel, active && styles.activeText]}>{tab.label}</Text>
                        </TouchableOpacity>
                    );
                })}
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    center: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    scrollContent: {
        paddingHorizontal: 20,
        width: '100%',
        maxWidth: 640,
        alignSelf: 'center',
    },
    tabBar: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        flexDirection: 'row',
        backgroundColor: 'rgba(5,5,5,0.96)',
        borderTopWidth: 1,
        borderColor: colors.border,
        paddingTop: 8,
    },
    tabItem: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 6,
        borderRadius: 10,
        marginHorizontal: 6,
    },
    activeTab: {
        backgroundColor: colors.accentSoft,
    },
    tabIcon: {
        fontSize: 18,
        color: colors.textFaint,
    },
    tabLabel: {
        fontSize: 9,
        fontWeight: '900',
        color: colors.textFaint,
        marginTop: 4,
        letterSpacing: 1,
    },
    activeText: {
        color: colors.accent,
    },
});
