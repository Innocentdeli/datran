import { getKV, type KV } from './kv';
import { randomUUID } from 'crypto';

export interface RadarPeer {
  id: string;
  name: string;
  type: 'desktop' | 'mobile' | 'tablet';
  platform?: string;
  avatarColor?: string;
  lastSeen: number;
  ip?: string;
}

export interface RadarBeamItem {
  id: string;
  fromPeerId: string;
  fromName: string;
  toPeerId: string;
  fileIds: string[];
  fileName?: string;
  fileSize?: number;
  timestamp: number;
  status: 'pending' | 'accepted' | 'declined';
}

const PEER_TTL_MS = 25_000;
const PEER_KEY_PREFIX = 'radar:peer:';
const PEERS_SET_KEY = 'radar:peers:active';
const INBOX_KEY_PREFIX = 'radar:inbox:';
const BEAM_TTL_MS = 120_000; // 2 minutes to accept a direct beam

export async function announcePeer(
  peer: Omit<RadarPeer, 'lastSeen'>,
  kv: KV = getKV()
): Promise<RadarPeer> {
  const now = Date.now();
  const record: RadarPeer = {
    ...peer,
    lastSeen: now,
  };

  const key = `${PEER_KEY_PREFIX}${peer.id}`;
  await kv.set(key, JSON.stringify(record), PEER_TTL_MS);
  await kv.zAddCapped(PEERS_SET_KEY, peer.id, now, now - PEER_TTL_MS, 500, PEER_TTL_MS * 4);

  return record;
}

export async function getNearbyPeers(
  excludePeerId?: string,
  kv: KV = getKV()
): Promise<RadarPeer[]> {
  const now = Date.now();
  const minScore = now - PEER_TTL_MS;
  const activeIds = await kv.zMembers(PEERS_SET_KEY, minScore);

  const peers: RadarPeer[] = [];
  for (const id of activeIds) {
    if (excludePeerId && id === excludePeerId) continue;
    const raw = await kv.get(`${PEER_KEY_PREFIX}${id}`);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as RadarPeer;
        peers.push(parsed);
      } catch {
        // ignore malformed
      }
    }
  }

  return peers;
}

export async function sendRadarBeam(
  payload: {
    fromPeerId: string;
    fromName: string;
    toPeerId?: string;
    toPeerIds?: string[];
    fileIds: string[];
    fileName?: string;
    fileSize?: number;
  },
  kv: KV = getKV()
): Promise<RadarBeamItem[]> {
  const targets = Array.from(
    new Set([
      ...(payload.toPeerIds || []),
      ...(payload.toPeerId ? [payload.toPeerId] : []),
    ])
  ).filter(Boolean);

  const now = Date.now();
  const beams: RadarBeamItem[] = [];

  for (const targetPeerId of targets) {
    const beamId = randomUUID();
    const beam: RadarBeamItem = {
      id: beamId,
      fromPeerId: payload.fromPeerId,
      fromName: payload.fromName,
      toPeerId: targetPeerId,
      fileIds: payload.fileIds,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      timestamp: now,
      status: 'pending',
    };

    const inboxKey = `${INBOX_KEY_PREFIX}${targetPeerId}`;
    const serialized = JSON.stringify(beam);
    await kv.listPush(inboxKey, serialized, 50, BEAM_TTL_MS);

    // Store direct beam record
    await kv.set(`radar:beam:${beamId}`, serialized, BEAM_TTL_MS);

    beams.push(beam);
  }

  return beams;
}

export async function getPendingRadarBeams(
  peerId: string,
  kv: KV = getKV()
): Promise<RadarBeamItem[]> {
  const inboxKey = `${INBOX_KEY_PREFIX}${peerId}`;
  const rawList = await kv.listDrain(inboxKey);

  const beams: RadarBeamItem[] = [];
  for (const raw of rawList) {
    try {
      const parsed = JSON.parse(raw) as RadarBeamItem;
      if (parsed.status === 'pending') {
        beams.push(parsed);
      }
    } catch {
      // ignore
    }
  }

  return beams;
}

export async function respondToRadarBeam(
  beamId: string,
  peerId: string,
  accept: boolean,
  kv: KV = getKV()
): Promise<RadarBeamItem | null> {
  const raw = await kv.get(`radar:beam:${beamId}`);
  if (!raw) return null;

  try {
    const beam = JSON.parse(raw) as RadarBeamItem;
    if (beam.toPeerId !== peerId) return null;

    beam.status = accept ? 'accepted' : 'declined';
    await kv.set(`radar:beam:${beamId}`, JSON.stringify(beam), BEAM_TTL_MS);
    return beam;
  } catch {
    return null;
  }
}
