'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Radio,
  Smartphone,
  Laptop,
  Tablet,
  Wifi,
  Upload,
  CheckCircle,
  XCircle,
  ArrowRight,
  ShieldCheck,
  Send,
  Download,
  Sparkles,
  Users,
  Check,
} from 'lucide-react';

interface RadarPeer {
  id: string;
  name: string;
  type: 'desktop' | 'mobile' | 'tablet';
  platform?: string;
  avatarColor?: string;
  lastSeen: number;
  ip?: string;
}

interface IncomingBeam {
  id: string;
  fromPeerId: string;
  fromName: string;
  fileIds: string[];
  fileName?: string;
  fileSize?: number;
  timestamp: number;
}

export default function RadarPage() {
  const [myId, setMyId] = useState<string>('');
  const [myName, setMyName] = useState<string>('Desktop PC');
  const [peers, setPeers] = useState<RadarPeer[]>([]);
  const [selectedPeerIds, setSelectedPeerIds] = useState<string[]>([]);
  const [incomingBeam, setIncomingBeam] = useState<IncomingBeam | null>(null);

  // Transfer state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [beaming, setBeaming] = useState(false);
  const [beamSuccess, setBeamSuccess] = useState(false);
  const [beamError, setBeamError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const targetPeers = peers.filter((p) => selectedPeerIds.includes(p.id));

  // Initialize persistent peer identity
  useEffect(() => {
    let id = localStorage.getItem('datran_radar_id');
    if (!id) {
      id = 'dt_' + Math.random().toString(36).substring(2, 10);
      localStorage.setItem('datran_radar_id', id);
    }
    setMyId(id);

    const ua = navigator.userAgent;
    let name = 'Desktop Workstation';
    if (/Macintosh/i.test(ua)) name = 'MacBook Pro';
    else if (/Windows/i.test(ua)) name = 'Windows PC';
    else if (/Linux/i.test(ua)) name = 'Linux Rig';
    setMyName(name);
  }, []);

  // Announce loop (every 3.5s)
  useEffect(() => {
    if (!myId) return;

    const announce = async () => {
      try {
        const res = await fetch('/api/radar/announce', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: myId,
            name: myName,
            type: 'desktop',
            platform: navigator.platform || 'Desktop',
          }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (data.peers) {
          setPeers(data.peers);
          // Prune stale selections
          setSelectedPeerIds((prev) =>
            prev.filter((id) => (data.peers as RadarPeer[]).some((p) => p.id === id))
          );
        }
      } catch {}
    };

    announce();
    const interval = setInterval(announce, 3500);
    return () => clearInterval(interval);
  }, [myId, myName]);

  // Poll for incoming beams
  useEffect(() => {
    if (!myId) return;

    const checkInbox = async () => {
      try {
        const res = await fetch(`/api/radar/inbox?peerId=${encodeURIComponent(myId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.beams && data.beams.length > 0) {
          setIncomingBeam(data.beams[0]);
        }
      } catch {}
    };

    checkInbox();
    const interval = setInterval(checkInbox, 2000);
    return () => clearInterval(interval);
  }, [myId]);

  const handleTogglePeer = (peer: RadarPeer) => {
    setSelectedPeerIds((prev) =>
      prev.includes(peer.id) ? prev.filter((id) => id !== peer.id) : [...prev, peer.id]
    );
    setBeamSuccess(false);
    setBeamError(null);
  };

  const handleSelectAll = () => {
    if (selectedPeerIds.length === peers.length) {
      setSelectedPeerIds([]);
    } else {
      setSelectedPeerIds(peers.map((p) => p.id));
    }
    setBeamSuccess(false);
    setBeamError(null);
  };

  const handleSendBeam = async () => {
    if (!selectedFile || selectedPeerIds.length === 0 || !myId) return;
    setBeaming(true);
    setBeamError(null);
    setBeamSuccess(false);

    try {
      // 1. Upload file to Datran
      const formData = new FormData();
      formData.append('file', selectedFile);

      const upRes = await fetch('/api/ingest', {
        method: 'POST',
        body: formData,
      });

      if (!upRes.ok) throw new Error('Upload failed');
      const upData = await upRes.json();
      const fileId = upData.shareId || upData.fileId || upData.id || upData.link?.split('/').pop();

      if (!fileId) throw new Error('Could not retrieve uploaded file ID');

      // 2. Dispatch beam to all selected recipient peers
      const beamRes = await fetch('/api/radar/beam', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromPeerId: myId,
          fromName: myName,
          toPeerIds: selectedPeerIds,
          fileIds: [fileId],
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
        }),
      });

      if (!beamRes.ok) throw new Error('Could not deliver beam signal to peers');

      try {
        const raw = localStorage.getItem('datran_saved_peers');
        const existingPeers = raw ? JSON.parse(raw) : [];
        const newRecords = targetPeers.map((p) => ({
          id: p.id,
          name: p.name,
          type: p.type || 'radar',
          lastConnected: Date.now(),
        }));
        const updated = [
          ...newRecords,
          ...existingPeers.filter((p: any) => !selectedPeerIds.includes(p.id)),
        ].slice(0, 15);
        localStorage.setItem('datran_saved_peers', JSON.stringify(updated));
      } catch {}

      setBeamSuccess(true);
      setSelectedFile(null);
      setTimeout(() => {
        setBeamSuccess(false);
        setSelectedPeerIds([]);
      }, 3500);
    } catch (err) {
      setBeamError(err instanceof Error ? err.message : 'Transfer failed');
    } finally {
      setBeaming(false);
    }
  };

  const handleRespondBeam = async (accept: boolean) => {
    if (!incomingBeam || !myId) return;
    try {
      await fetch('/api/radar/inbox', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          beamId: incomingBeam.id,
          peerId: myId,
          accept,
        }),
      });

      if (accept && incomingBeam.fileIds?.length > 0) {
        // Automatically save each received file directly to Downloads
        for (const fId of incomingBeam.fileIds) {
          const a = document.createElement('a');
          a.href = `/api/stream?file=${encodeURIComponent(fId)}&download=1`;
          a.download = incomingBeam.fileName || `beamed-${fId.slice(0, 8)}`;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        }

        // Save peer to recent connections
        try {
          const raw = localStorage.getItem('datran_saved_peers');
          const peers = raw ? JSON.parse(raw) : [];
          const updated = [
            {
              id: incomingBeam.fromPeerId || incomingBeam.fromName,
              name: incomingBeam.fromName,
              type: 'radar',
              lastConnected: Date.now(),
            },
            ...peers.filter((p: any) => p.id !== (incomingBeam.fromPeerId || incomingBeam.fromName)),
          ].slice(0, 10);
          localStorage.setItem('datran_saved_peers', JSON.stringify(updated));
        } catch {}
      }
    } catch {}
    setIncomingBeam(null);
  };

  return (
    <main className="min-h-[85vh] flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Background glow effects */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[700px] h-[700px] bg-cyan-500/5 rounded-full blur-[140px] pointer-events-none" />

      {/* INCOMING BEAM MODAL */}
      <AnimatePresence>
        {incomingBeam && (
          <motion.div
            initial={{ opacity: 0, y: -40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -20, scale: 0.95 }}
            className="fixed top-20 z-50 max-w-md w-full px-4"
          >
            <div className="bg-slate-900/95 border border-cyan-500/40 rounded-2xl p-5 shadow-2xl shadow-cyan-500/20 backdrop-blur-xl">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-full bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-400">
                  <Sparkles className="w-5 h-5 animate-spin" style={{ animationDuration: '4s' }} />
                </div>
                <div>
                  <h4 className="text-white font-bold text-base">Incoming Direct Beam!</h4>
                  <p className="text-gray-400 text-xs">from {incomingBeam.fromName}</p>
                </div>
              </div>

              <div className="bg-slate-800/60 rounded-xl p-3 mb-4 border border-white/5">
                <p className="text-sm font-semibold text-white truncate">
                  {incomingBeam.fileName || 'Shared Document'}
                </p>
                {incomingBeam.fileSize ? (
                  <p className="text-xs text-gray-400 mt-0.5">
                    {(incomingBeam.fileSize / 1024 / 1024).toFixed(2)} MB • Direct Transfer
                  </p>
                ) : null}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => handleRespondBeam(false)}
                  className="flex-1 py-2 px-3 rounded-xl bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-xs font-semibold transition-colors"
                >
                  Decline
                </button>
                <button
                  onClick={() => handleRespondBeam(true)}
                  className="flex-1 py-2 px-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition-all shadow-lg shadow-cyan-500/25 flex items-center justify-center gap-1.5"
                >
                  <Download className="w-3.5 h-3.5" />
                  Accept & Open
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* HEADER SECTION */}
      <div className="text-center mb-6 relative z-10 max-w-xl">
        <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-semibold mb-4 tracking-wide uppercase">
          <Wifi className="w-3.5 h-3.5 animate-pulse" />
          Zero-Internet Local Radar
        </div>
        <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
          AirDrop-Style Local Beam
        </h1>
        <p className="text-gray-400 text-sm sm:text-base mt-2">
          Discover phones, tablets, and laptops on your Wi-Fi or hotspot. Tap devices to multi-select and beam files directly at gigabit local speeds.
        </p>
      </div>

      {/* QUICK MULTI-BEAM TOOLBAR */}
      {peers.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2.5 mb-4 z-10">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900/80 border border-cyan-500/20 text-xs text-gray-300 backdrop-blur">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>
              {peers.length} active device{peers.length > 1 ? 's' : ''} nearby
            </span>
          </div>

          <button
            onClick={handleSelectAll}
            className="px-3 py-1.5 rounded-full bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 text-cyan-400 text-xs font-semibold transition-colors"
          >
            {selectedPeerIds.length === peers.length
              ? 'Deselect All'
              : peers.length > 1 && selectedPeerIds.length > 0
              ? `Select All (${peers.length})`
              : 'Select All'}
          </button>

          {peers.length > 1 && selectedPeerIds.length === 0 && (
            <button
              onClick={() => {
                setSelectedPeerIds(peers.map((p) => p.id));
                fileInputRef.current?.click();
              }}
              className="px-3.5 py-1.5 rounded-full bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold transition-all shadow-md shadow-cyan-500/20 flex items-center gap-1.5"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Beam to All Nearby ({peers.length})
            </button>
          )}
        </div>
      )}

      {/* RADAR CANVAS CONTAINER */}
      <div className="relative w-[360px] h-[360px] sm:w-[460px] sm:h-[460px] flex items-center justify-center my-4">
        {/* Concentric rings */}
        <div className="absolute inset-0 rounded-full border border-cyan-500/15" />
        <div className="absolute inset-[15%] rounded-full border border-cyan-500/20" />
        <div className="absolute inset-[32%] rounded-full border border-cyan-500/25" />
        <div className="absolute inset-[50%] rounded-full border border-cyan-500/30" />

        {/* Radar sweeping beam */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            background: 'conic-gradient(from 0deg, rgba(0, 242, 255, 0.18) 0deg, transparent 65deg, transparent 360deg)',
            animation: 'radarSweep 5s linear infinite',
          }}
        />

        {/* Center Node: This Device */}
        <motion.div
          whileHover={{ scale: 1.05 }}
          className="relative z-20 flex flex-col items-center justify-center w-24 h-24 sm:w-28 sm:h-28 rounded-full bg-slate-900 border-2 border-cyan-400 shadow-2xl shadow-cyan-500/40 cursor-default"
        >
          <Laptop className="w-7 h-7 sm:w-8 sm:h-8 text-cyan-400 mb-1" />
          <span className="text-[11px] sm:text-xs font-bold text-white max-w-[80px] truncate text-center">
            {myName}
          </span>
          <span className="text-[9px] text-cyan-400/80 font-medium tracking-wider uppercase">
            Broadcasting
          </span>
        </motion.div>

        {/* Discovered Peer Nodes */}
        {peers.length === 0 ? (
          <div className="absolute bottom-6 text-center pointer-events-none">
            <p className="text-xs text-gray-500 animate-pulse">
              Listening for nearby Datran devices on this network...
            </p>
          </div>
        ) : (
          peers.map((peer, idx) => {
            // Position around circle using polar coordinates
            const count = peers.length;
            const angle = (idx / count) * 2 * Math.PI - Math.PI / 2;
            const radius = 135; // px from center
            const x = Math.cos(angle) * radius;
            const y = Math.sin(angle) * radius;

            const isSelected = selectedPeerIds.includes(peer.id);

            return (
              <motion.button
                key={peer.id}
                onClick={() => handleTogglePeer(peer)}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                whileHover={{ scale: 1.12 }}
                whileTap={{ scale: 0.95 }}
                style={{
                  transform: `translate(${x}px, ${y}px)`,
                }}
                className={`absolute z-30 flex flex-col items-center justify-center w-20 h-20 sm:w-24 sm:h-24 rounded-full transition-all ${
                  isSelected
                    ? 'bg-cyan-500 text-slate-950 ring-4 ring-cyan-300 shadow-2xl shadow-cyan-400/60'
                    : 'bg-slate-900/90 border-2 border-cyan-500/50 text-white shadow-xl hover:border-cyan-400 hover:shadow-cyan-500/30 backdrop-blur-md'
                }`}
              >
                {isSelected && (
                  <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-slate-950 text-cyan-400 border border-cyan-300 flex items-center justify-center shadow">
                    <Check className="w-3 h-3 stroke-[3]" />
                  </div>
                )}
                {peer.type === 'mobile' ? (
                  <Smartphone className={`w-6 h-6 mb-0.5 ${isSelected ? 'text-slate-950' : 'text-cyan-400'}`} />
                ) : peer.type === 'tablet' ? (
                  <Tablet className={`w-6 h-6 mb-0.5 ${isSelected ? 'text-slate-950' : 'text-cyan-400'}`} />
                ) : (
                  <Laptop className={`w-6 h-6 mb-0.5 ${isSelected ? 'text-slate-950' : 'text-cyan-400'}`} />
                )}
                <span className="text-[10px] sm:text-[11px] font-bold max-w-[70px] truncate text-center px-1">
                  {peer.name}
                </span>
                <span
                  className={`text-[8px] uppercase font-semibold tracking-wider ${
                    isSelected ? 'text-slate-900' : 'text-cyan-400'
                  }`}
                >
                  {isSelected ? 'SELECTED' : 'Direct LAN'}
                </span>
              </motion.button>
            );
          })
        )}
      </div>

      {/* SELECTED PEERS BEAM DRAWER */}
      <AnimatePresence>
        {selectedPeerIds.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="w-full max-w-lg mt-6 bg-slate-900/90 border border-cyan-500/30 rounded-2xl p-6 backdrop-blur-xl shadow-2xl shadow-cyan-500/10"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center text-cyan-400">
                  {selectedPeerIds.length > 1 ? (
                    <Users className="w-5 h-5" />
                  ) : targetPeers[0]?.type === 'mobile' ? (
                    <Smartphone className="w-5 h-5" />
                  ) : (
                    <Laptop className="w-5 h-5" />
                  )}
                </div>
                <div>
                  <h3 className="text-white font-bold text-base">
                    {selectedPeerIds.length === 1
                      ? `Beam to ${targetPeers[0]?.name || 'Device'}`
                      : `Broadcast to ${selectedPeerIds.length} Devices`}
                  </h3>
                  <p className="text-gray-400 text-xs">
                    {selectedPeerIds.length === 1
                      ? 'Direct high-speed local stream'
                      : 'Simultaneous gigabit broadcast across local network'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => setSelectedPeerIds([])}
                className="text-gray-400 hover:text-white p-1"
              >
                <XCircle className="w-5 h-5" />
              </button>
            </div>

            {/* RECIPIENT CHIPS IF MULTIPLE */}
            {selectedPeerIds.length > 1 && (
              <div className="flex flex-wrap gap-1.5 mb-4">
                {targetPeers.map((p) => (
                  <span
                    key={p.id}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-medium"
                  >
                    {p.name}
                    <button
                      onClick={() =>
                        setSelectedPeerIds((prev) => prev.filter((id) => id !== p.id))
                      }
                      className="hover:text-red-400 text-cyan-400/80 font-bold"
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}

            {/* FILE SELECTION */}
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.[0]) setSelectedFile(e.target.files[0]);
              }}
            />

            {!selectedFile ? (
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-cyan-500/30 hover:border-cyan-400/70 rounded-xl p-6 text-center cursor-pointer transition-colors bg-cyan-500/5 hover:bg-cyan-500/10 mb-4"
              >
                <Upload className="w-8 h-8 text-cyan-400 mx-auto mb-2" />
                <p className="text-sm font-semibold text-white">Click or drop a file to beam</p>
                <p className="text-xs text-gray-400 mt-1">Photos, 4K videos, documents, zip archives</p>
              </div>
            ) : (
              <div className="bg-slate-800/80 rounded-xl p-4 border border-cyan-500/20 flex items-center justify-between mb-4">
                <div className="min-w-0 pr-3">
                  <p className="text-sm font-semibold text-white truncate">{selectedFile.name}</p>
                  <p className="text-xs text-gray-400">
                    {(selectedFile.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
                <button
                  onClick={() => setSelectedFile(null)}
                  className="text-gray-400 hover:text-red-400"
                >
                  <XCircle className="w-5 h-5" />
                </button>
              </div>
            )}

            {beamError && (
              <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-400 text-xs mb-4">
                {beamError}
              </div>
            )}

            {beamSuccess && (
              <div className="p-3 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-xs mb-4 flex items-center gap-2">
                <CheckCircle className="w-4 h-4" />
                Beam delivered to {selectedPeerIds.length > 1 ? `${selectedPeerIds.length} devices` : targetPeers[0]?.name || 'device'} successfully!
              </div>
            )}

            <button
              onClick={handleSendBeam}
              disabled={!selectedFile || beaming}
              className="w-full py-3 px-4 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:bg-cyan-500/30 disabled:text-gray-500 text-slate-950 font-bold text-sm transition-all shadow-lg shadow-cyan-500/25 flex items-center justify-center gap-2"
            >
              {beaming ? (
                <>
                  <Radio className="w-4 h-4 animate-spin" />
                  Beaming directly to {selectedPeerIds.length} device{selectedPeerIds.length > 1 ? 's' : ''}...
                </>
              ) : (
                <>
                  <Send className="w-4 h-4" />
                  {selectedPeerIds.length > 1
                    ? `Beam to All ${selectedPeerIds.length} Devices`
                    : 'Beam Now'}
                </>
              )}
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <style jsx>{`
        @keyframes radarSweep {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>
    </main>
  );
}
