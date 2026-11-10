import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

export interface RadarPeer {
    id: string;
    name: string;
    type: 'desktop' | 'mobile' | 'tablet';
    platform?: string;
    avatarColor?: string;
    lastSeen: number;
    ip?: string;
}

export interface IncomingBeam {
    id: string;
    fromPeerId: string;
    fromName: string;
    fileIds: string[];
    fileName?: string;
    fileSize?: number;
    timestamp: number;
}

const STORAGE_KEY_ID = '@datran_radar_peer_id';
const STORAGE_KEY_NAME = '@datran_radar_device_name';

let cachedId: string | null = null;
let cachedName: string | null = null;

export async function getRadarDeviceId(): Promise<string> {
    if (cachedId) return cachedId;
    try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY_ID);
        if (stored) {
            cachedId = stored;
            return stored;
        }
    } catch {}

    const fresh = 'mob_' + Math.random().toString(36).substring(2, 10);
    cachedId = fresh;
    AsyncStorage.setItem(STORAGE_KEY_ID, fresh).catch(() => {});
    return fresh;
}

export async function getRadarDeviceName(): Promise<string> {
    if (cachedName) return cachedName;
    try {
        const stored = await AsyncStorage.getItem(STORAGE_KEY_NAME);
        if (stored) {
            cachedName = stored;
            return stored;
        }
    } catch {}

    const defaultName = Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android Device' : 'Mobile Device';
    cachedName = defaultName;
    return defaultName;
}

export async function setRadarDeviceName(name: string): Promise<void> {
    cachedName = name;
    await AsyncStorage.setItem(STORAGE_KEY_NAME, name);
}

export async function announceToRadar(serverUrl: string): Promise<RadarPeer[]> {
    const id = await getRadarDeviceId();
    const name = await getRadarDeviceName();
    const cleanUrl = serverUrl.replace(/\/+$/, '');

    const res = await fetch(`${cleanUrl}/api/radar/announce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            id,
            name,
            type: 'mobile',
            platform: Platform.OS,
        }),
    });

    if (!res.ok) throw new Error('Radar announcement failed');
    const data = await res.json();
    return (data.peers || []) as RadarPeer[];
}

export async function pollRadarInbox(serverUrl: string): Promise<IncomingBeam[]> {
    const id = await getRadarDeviceId();
    const cleanUrl = serverUrl.replace(/\/+$/, '');

    const res = await fetch(`${cleanUrl}/api/radar/inbox?peerId=${encodeURIComponent(id)}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.beams || []) as IncomingBeam[];
}

export async function sendBeamToPeers(
    serverUrl: string,
    targetPeerIds: string[],
    fileIds: string[],
    fileName?: string,
    fileSize?: number,
): Promise<boolean> {
    const id = await getRadarDeviceId();
    const name = await getRadarDeviceName();
    const cleanUrl = serverUrl.replace(/\/+$/, '');

    const res = await fetch(`${cleanUrl}/api/radar/beam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fromPeerId: id,
            fromName: name,
            toPeerIds: targetPeerIds,
            fileIds,
            fileName,
            fileSize,
        }),
    });

    return res.ok;
}

export async function sendBeamToPeer(
    serverUrl: string,
    targetPeerId: string,
    fileIds: string[],
    fileName?: string,
    fileSize?: number,
): Promise<boolean> {
    return sendBeamToPeers(serverUrl, [targetPeerId], fileIds, fileName, fileSize);
}

export async function respondToBeam(
    serverUrl: string,
    beamId: string,
    accept: boolean,
): Promise<boolean> {
    const id = await getRadarDeviceId();
    const cleanUrl = serverUrl.replace(/\/+$/, '');

    const res = await fetch(`${cleanUrl}/api/radar/inbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            beamId,
            peerId: id,
            accept,
        }),
    });

    return res.ok;
}
