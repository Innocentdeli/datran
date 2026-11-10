import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DocumentPickerAsset } from 'expo-document-picker';

import { hasSession, onSessionChange } from './src/auth/session';
import { AuthModal } from './src/screens/AuthModal';
import { BeamHubModal } from './src/screens/BeamHubModal';
import { BeamScreen } from './src/screens/BeamScreen';
import { FileRequestsScreen } from './src/screens/FileRequestsScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { LobbyModal } from './src/screens/LobbyModal';
import { PairModal } from './src/screens/PairModal';
import { RadarModal } from './src/screens/RadarModal';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { SpacesModal } from './src/screens/SpacesModal';
import { SpacesScreen } from './src/screens/SpacesScreen';
import { UploadScreen } from './src/screens/UploadScreen';
import { autoSaveFile } from './src/storage/autoSave';
import { addHistoryItem, loadHistory, saveHistory, type HistoryItem } from './src/storage/history';
import { loadSettings, saveSettings, type Settings } from './src/storage/settings';
import { colors, radius, space } from './src/theme';
import { haptic, Icon, type IconName, ToastProvider, useToast } from './src/ui';

type Tab = 'upload' | 'beam' | 'spaces' | 'inbox';

interface TabItemConfig {
    key: Tab;
    label: string;
    iconActive: IconName;
    iconInactive: IconName;
}

const TABS: readonly TabItemConfig[] = [
    { key: 'upload', label: 'SEND', iconActive: 'cloud-upload', iconInactive: 'cloud-upload-outline' },
    { key: 'beam', label: 'BEAM', iconActive: 'flash', iconInactive: 'flash-outline' },
    { key: 'spaces', label: 'SPACES', iconActive: 'folder-open', iconInactive: 'folder-open-outline' },
    { key: 'inbox', label: 'ACTIVITY', iconActive: 'receipt', iconInactive: 'receipt-outline' },
];

export default function App() {
    return (
        <SafeAreaProvider>
            <ToastProvider>
                <Main />
                <StatusBar style="light" />
            </ToastProvider>
        </SafeAreaProvider>
    );
}

function Main() {
    const insets = useSafeAreaInsets();
    const toast = useToast();
    const [activeTab, setActiveTab] = useState<Tab>('upload');
    const [settings, setSettings] = useState<Settings | null>(null);
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [signedIn, setSignedIn] = useState(false);
    const [authModalVisible, setAuthModalVisible] = useState(false);
    const [pairModalVisible, setPairModalVisible] = useState(false);
    const [radarModalVisible, setRadarModalVisible] = useState(false);
    const [lobbyModalVisible, setLobbyModalVisible] = useState(false);
    const [spacesModalVisible, setSpacesModalVisible] = useState(false);
    const [beamHubModalVisible, setBeamHubModalVisible] = useState(false);
    const [settingsVisible, setSettingsVisible] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [sharedAsset, setSharedAsset] = useState<DocumentPickerAsset | null>(null);

    const handleIncomingUrl = useCallback((rawUrl: string | null | undefined) => {
        if (!rawUrl) return;
        try {
            const clean = rawUrl.trim();
            if (clean.includes('radar')) {
                setRadarModalVisible(true);
            } else if (clean.includes('pair')) {
                setPairModalVisible(true);
            } else if (clean.includes('lobby')) {
                setLobbyModalVisible(true);
            } else if (clean.includes('share') || clean.includes('send')) {
                const parsed = new URL(clean);
                const uri = parsed.searchParams.get('uri') || parsed.searchParams.get('url');
                const name = parsed.searchParams.get('name') || parsed.searchParams.get('filename') || 'shared_document';
                if (uri) {
                    setSharedAsset({
                        uri,
                        name,
                        lastModified: Date.now(),
                    });
                    setActiveTab('upload');
                }
            }
        } catch {
            if (rawUrl.includes('radar')) setRadarModalVisible(true);
            else if (rawUrl.includes('pair')) setPairModalVisible(true);
            else if (rawUrl.includes('lobby')) setLobbyModalVisible(true);
        }
    }, []);

    useEffect(() => {
        Linking.getInitialURL().then(handleIncomingUrl);
        const sub = Linking.addEventListener('url', (e) => handleIncomingUrl(e.url));
        return () => sub.remove();
    }, [handleIncomingUrl]);

    const loadAll = useCallback(async () => {
        const [s, h, session] = await Promise.all([loadSettings(), loadHistory(), hasSession()]);
        setSettings(s);
        setHistory(h);
        setSignedIn(session);
    }, []);

    useEffect(() => {
        let alive = true;
        void Promise.all([loadSettings(), loadHistory(), hasSession()]).then(([s, h, session]) => {
            if (!alive) return;
            setSettings(s);
            setHistory(h);
            setSignedIn(session);
        });
        const unsubscribe = onSessionChange((value) => {
            if (alive) setSignedIn(value);
        });
        return () => {
            alive = false;
            unsubscribe();
        };
    }, []);

    const handleRefresh = useCallback(async () => {
        haptic.light();
        setRefreshing(true);
        try {
            await loadAll();
        } finally {
            setRefreshing(false);
        }
    }, [loadAll]);

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
                <ActivityIndicator color={colors.primary} size="large" />
            </View>
        );
    }

    return (
        <View style={styles.container}>
            <LinearGradient colors={['#080e14', '#04070a', colors.background]} style={StyleSheet.absoluteFill} />

            {/* TOP NAVIGATION / BRAND BAR */}
            <View style={[styles.topBar, { paddingTop: Math.max(insets.top + 8, 16) }]}>
                <View style={styles.brandRow}>
                    <View style={styles.logoBadge}>
                        <Icon name="flash" size={16} color={colors.primary} />
                    </View>
                    <Text style={styles.brandTitle}>DATRAN</Text>
                </View>

                <View style={styles.topBarActions}>
                    {/* Clean user account / auth button */}
                    <Pressable
                        onPress={() => {
                            haptic.tap();
                            if (signedIn) {
                                setSettingsVisible(true);
                            } else {
                                setAuthModalVisible(true);
                            }
                        }}
                        style={({ pressed }) => [styles.accountPill, pressed && styles.accountPillPressed]}
                        accessibilityRole="button"
                        accessibilityLabel={signedIn ? 'Signed in account' : 'Sign in or register'}
                    >
                        <View style={[styles.statusDot, { backgroundColor: signedIn ? colors.success : colors.primary }]} />
                        <Icon
                            name={signedIn ? 'person-circle-outline' : 'log-in-outline'}
                            size={15}
                            color={signedIn ? colors.textMuted : colors.primary}
                        />
                        <Text style={[styles.accountText, !signedIn && { color: colors.primary }]}>
                            {signedIn ? 'Account' : 'Sign In'}
                        </Text>
                    </Pressable>

                    {/* Settings icon button */}
                    <Pressable
                        onPress={() => {
                            haptic.tap();
                            setSettingsVisible(true);
                        }}
                        style={({ pressed }) => [styles.settingsBtn, pressed && styles.settingsBtnPressed]}
                        accessibilityRole="button"
                        accessibilityLabel="App Settings"
                    >
                        <Icon
                            name="settings-outline"
                            size={17}
                            color={colors.textMuted}
                        />
                    </Pressable>
                </View>
            </View>

            {/* SCREEN SCROLL VIEW WITH PULL-TO-REFRESH */}
            <ScrollView
                contentContainerStyle={[
                    styles.scrollContent,
                    {
                        paddingTop: space.md,
                        paddingBottom: insets.bottom + 96,
                    },
                ]}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={handleRefresh}
                        tintColor={colors.primary}
                        colors={[colors.primary]}
                    />
                }
            >
                {activeTab === 'upload' ? (
                    <UploadScreen
                        settings={settings}
                        signedIn={signedIn}
                        recentItems={history}
                        sharedAsset={sharedAsset}
                        onUploaded={(item) => updateHistory((items) => addHistoryItem(items, item))}
                        onOpenSettings={() => setSettingsVisible(true)}
                        onOpenInbox={() => setActiveTab('inbox')}
                        onOpenFileRequests={() => setActiveTab('spaces')}
                    />
                ) : null}

                {activeTab === 'beam' ? (
                    <BeamScreen
                        serverUrl={settings.serverUrl}
                        signedIn={signedIn}
                        onOpenRadar={() => setRadarModalVisible(true)}
                        onOpenPair={() => setPairModalVisible(true)}
                        onOpenLobby={() => setLobbyModalVisible(true)}
                        onOpenAuth={() => setAuthModalVisible(true)}
                    />
                ) : null}

                {activeTab === 'spaces' ? (
                    <SpacesScreen
                        serverUrl={settings.serverUrl}
                        signedIn={signedIn}
                        onOpenAuth={() => setAuthModalVisible(true)}
                        onOpenSpacesModal={() => setSpacesModalVisible(true)}
                    />
                ) : null}

                {activeTab === 'inbox' ? (
                    <InboxScreen
                        items={history}
                        onRemove={(id) => updateHistory((items) => items.filter((i) => i.id !== id))}
                        onClear={() => updateHistory(() => [])}
                        signedIn={signedIn}
                        serverUrl={settings.serverUrl}
                        onUploadPress={() => setActiveTab('upload')}
                        onSettingsPress={() => setSettingsVisible(true)}
                        onOpenAuth={() => setAuthModalVisible(true)}
                        onOpenLobby={() => setLobbyModalVisible(true)}
                        onOpenSpaces={() => setSpacesModalVisible(true)}
                        onOpenPair={() => setPairModalVisible(true)}
                        onAddHistoryItem={(item) => updateHistory((items) => addHistoryItem(items, item))}
                    />
                ) : null}
            </ScrollView>

            {/* FLOATING FROSTED BOTTOM TAB BAR */}
            <View style={[styles.tabBarWrap, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                <View style={styles.tabBar} accessibilityRole="tablist">
                    {TABS.map((tab) => {
                        const isActive = activeTab === tab.key;
                        return (
                            <Pressable
                                key={tab.key}
                                onPress={() => {
                                    if (activeTab !== tab.key) haptic.light();
                                    setActiveTab(tab.key);
                                }}
                                accessibilityRole="tab"
                                accessibilityState={{ selected: isActive }}
                                accessibilityLabel={tab.label}
                                style={[styles.tabItem, isActive && styles.tabItemActive]}
                            >
                                <View style={styles.tabIconWrap}>
                                    <Icon
                                        name={isActive ? tab.iconActive : tab.iconInactive}
                                        size={20}
                                        color={isActive ? colors.primary : colors.textFaint}
                                    />
                                    {tab.key === 'inbox' && history.length > 0 ? (
                                        <View style={styles.tabBadge}>
                                            <Text style={styles.tabBadgeText}>
                                                {history.length > 99 ? '99+' : history.length}
                                            </Text>
                                        </View>
                                    ) : null}
                                </View>
                                <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]}>
                                    {tab.label}
                                </Text>
                            </Pressable>
                        );
                    })}
                </View>
            </View>

            {/* DEDICATED SIGN IN / SIGN UP MODAL */}
            <AuthModal
                visible={authModalVisible}
                serverUrl={settings.serverUrl}
                onClose={() => setAuthModalVisible(false)}
                onSuccess={() => setSignedIn(true)}
            />

            {/* DEDICATED APP SETTINGS MODAL */}
            <Modal
                visible={settingsVisible}
                animationType="slide"
                presentationStyle="pageSheet"
                onRequestClose={() => setSettingsVisible(false)}
            >
                <View style={{ flex: 1, backgroundColor: colors.background }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: space.lg, paddingTop: Math.max(insets.top + 8, 20), paddingBottom: space.md, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>App Settings</Text>
                        <Pressable
                            onPress={() => setSettingsVisible(false)}
                            style={{ padding: 6, borderRadius: 16, backgroundColor: colors.surfaceRaised }}
                        >
                            <Icon name="close" size={20} color={colors.text} />
                        </Pressable>
                    </View>
                    <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: insets.bottom + 40 }}>
                        <SettingsScreen
                            settings={settings}
                            signedIn={signedIn}
                            onSave={handleSaveSettings}
                            onOpenAuth={() => {
                                setSettingsVisible(false);
                                setAuthModalVisible(true);
                            }}
                            onOpenPair={() => {
                                setSettingsVisible(false);
                                setPairModalVisible(true);
                            }}
                        />
                    </ScrollView>
                </View>
            </Modal>

            {/* DESKTOP QR PAIRING MODAL */}
            <PairModal
                visible={pairModalVisible}
                serverUrl={settings.serverUrl}
                onClose={() => setPairModalVisible(false)}
                onFilesReceived={async (links) => {
                    let savedCount = 0;
                    for (const link of links) {
                        const id = link.split('/').pop() || String(Date.now());
                        const downloadUrl = `${settings.serverUrl.replace(/\/+$/, '')}/api/stream?file=${id}&download=1`;
                        const saveRes = await autoSaveFile(downloadUrl, `paired-${id.slice(0, 8)}`);
                        if (saveRes.success) savedCount++;

                        updateHistory((items) =>
                            addHistoryItem(items, {
                                id,
                                filename: saveRes.filename,
                                size: saveRes.size || 0,
                                link,
                                serverUrl: settings.serverUrl,
                                uploadedAt: Date.now(),
                                localUri: saveRes.localUri,
                                savedLocally: saveRes.success,
                            }),
                        );
                    }
                    if (savedCount > 0) {
                        toast.show(`📥 Automatically saved ${savedCount} file${savedCount > 1 ? 's' : ''} to local storage!`);
                    }
                }}
            />

            {/* LIVE LOBBY ROOM MODAL */}
            <LobbyModal
                visible={lobbyModalVisible}
                serverUrl={settings.serverUrl}
                onClose={() => setLobbyModalVisible(false)}
                onFilesReceived={async (files) => {
                    let savedCount = 0;
                    for (const file of files) {
                        const id = file.link.split('/').pop() || String(Date.now());
                        const downloadUrl = `${settings.serverUrl.replace(/\/+$/, '')}/api/stream?file=${id}&download=1`;
                        const saveRes = await autoSaveFile(downloadUrl, file.name);
                        if (saveRes.success) savedCount++;

                        updateHistory((items) =>
                            addHistoryItem(items, {
                                id,
                                filename: file.name,
                                size: file.size,
                                link: file.link,
                                serverUrl: settings.serverUrl,
                                uploadedAt: Date.now(),
                                localUri: saveRes.localUri,
                                savedLocally: saveRes.success,
                            }),
                        );
                    }
                    if (savedCount > 0) {
                        toast.show(`📥 Automatically saved ${savedCount} file${savedCount > 1 ? 's' : ''} to local storage!`);
                    }
                }}
            />

            {/* SHARED SPACES EXPLORER MODAL */}
            <SpacesModal
                visible={spacesModalVisible}
                serverUrl={settings.serverUrl}
                signedIn={signedIn}
                onClose={() => setSpacesModalVisible(false)}
                onOpenAuth={() => setAuthModalVisible(true)}
                onSelectFile={(file) => {
                    updateHistory((items) => {
                        const id = file.link.split('/').pop() || String(Date.now());
                        return addHistoryItem(items, {
                            id,
                            filename: file.name,
                            size: file.size,
                            link: file.link,
                            serverUrl: settings.serverUrl,
                            uploadedAt: Date.now(),
                        });
                    });
                }}
            />
            {/* UNIFIED BEAM HUB MODAL (AIRDROP STYLE) */}
            <BeamHubModal
                visible={beamHubModalVisible}
                signedIn={signedIn}
                onClose={() => setBeamHubModalVisible(false)}
                onOpenRadar={() => setRadarModalVisible(true)}
                onOpenPair={() => setPairModalVisible(true)}
                onOpenLobby={() => setLobbyModalVisible(true)}
                onOpenSpaces={() => setSpacesModalVisible(true)}
                onOpenUpload={() => setActiveTab('upload')}
                onOpenAuth={() => setAuthModalVisible(true)}
            />

            {/* AIRDROP-STYLE ZERO-INTERNET LOCAL RADAR MODAL */}
            <RadarModal
                visible={radarModalVisible}
                serverUrl={settings.serverUrl}
                onClose={() => setRadarModalVisible(false)}
                onFilesReceived={async (links) => {
                    let savedCount = 0;
                    for (const link of links) {
                        const id = link.split('/').pop() || String(Date.now());
                        const downloadUrl = `${settings.serverUrl.replace(/\/+$/, '')}/api/stream?file=${id}&download=1`;
                        const saveRes = await autoSaveFile(downloadUrl, `radar-beamed-${id.slice(0, 8)}`);
                        if (saveRes.success) savedCount++;

                        updateHistory((items) =>
                            addHistoryItem(items, {
                                id,
                                filename: saveRes.filename,
                                size: saveRes.size || 0,
                                link,
                                serverUrl: settings.serverUrl,
                                uploadedAt: Date.now(),
                                localUri: saveRes.localUri,
                                savedLocally: saveRes.success,
                            }),
                        );
                    }
                    if (savedCount > 0) {
                        toast.show(`📥 Automatically saved ${savedCount} beamed file${savedCount > 1 ? 's' : ''} to local storage!`);
                    }
                }}
            />
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
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: space.lg,
        paddingBottom: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: 'rgba(255,255,255,0.06)',
        backgroundColor: 'rgba(7, 10, 15, 0.85)',
    },
    brandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    logoBadge: {
        width: 28,
        height: 28,
        borderRadius: 8,
        backgroundColor: colors.primarySoft,
        borderWidth: 1,
        borderColor: colors.primaryBorder,
        alignItems: 'center',
        justifyContent: 'center',
    },
    brandTitle: {
        color: colors.text,
        fontSize: 16,
        fontWeight: '900',
        letterSpacing: 2,
    },
    topBarActions: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    settingsBtn: {
        width: 32,
        height: 32,
        borderRadius: 10,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.border,
        alignItems: 'center',
        justifyContent: 'center',
    },
    settingsBtnPressed: {
        backgroundColor: colors.surfacePressed,
    },
    accountPill: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceRaised,
        borderWidth: 1,
        borderColor: colors.border,
    },
    accountPillPressed: {
        backgroundColor: colors.surfacePressed,
    },
    statusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    accountText: {
        color: colors.textMuted,
        fontSize: 12,
        fontWeight: '600',
    },
    beamFab: {
        alignItems: 'center',
        justifyContent: 'center',
        marginHorizontal: space.sm,
        top: -14,
    },
    beamFabPressed: {
        transform: [{ scale: 0.94 }],
    },
    beamFabGradient: {
        width: 52,
        height: 52,
        borderRadius: 26,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: colors.primary,
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.6,
        shadowRadius: 12,
        elevation: 8,
    },
    beamFabText: {
        fontSize: 9,
        fontWeight: '900',
        color: colors.primary,
        marginTop: 2,
        letterSpacing: 1,
    },
    scrollContent: {
        paddingHorizontal: space.lg,
        width: '100%',
        maxWidth: 640,
        alignSelf: 'center',
    },
    tabBarWrap: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        paddingHorizontal: space.lg,
        alignItems: 'center',
        pointerEvents: 'box-none',
    },
    tabBar: {
        flexDirection: 'row',
        backgroundColor: 'rgba(12, 18, 25, 0.95)',
        borderWidth: 1,
        borderColor: colors.borderStrong,
        borderRadius: 24,
        padding: 5,
        width: '100%',
        maxWidth: 500,
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.5,
        shadowRadius: 16,
        elevation: 12,
    },
    tabItem: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 8,
        borderRadius: 18,
    },
    tabItemActive: {
        backgroundColor: colors.primarySoft,
    },
    tabIconWrap: {
        position: 'relative',
    },
    tabBadge: {
        position: 'absolute',
        top: -4,
        right: -10,
        backgroundColor: colors.primary,
        borderRadius: 8,
        paddingHorizontal: 4,
        paddingVertical: 1,
        minWidth: 16,
        alignItems: 'center',
        justifyContent: 'center',
    },
    tabBadgeText: {
        color: colors.onPrimary,
        fontSize: 9,
        fontWeight: '800',
    },
    tabLabel: {
        fontSize: 10,
        fontWeight: '700',
        color: colors.textFaint,
        marginTop: 3,
        letterSpacing: 0.8,
    },
    tabLabelActive: {
        color: colors.primary,
    },
});
