'use client';

import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Zap, Copy, Check } from 'lucide-react';
import { ManualPeer, type ManualPeerStatus } from '@/lib/WebRTCService';
import Button from '@/components/ui/Button';

/**
 * Direct browser-to-browser file transfer over a WebRTC data channel with manual
 * (copy/paste) signaling. Status lines show the real RTCPeerConnection / data channel state
 * and the measured ICE path; nothing is reported as connected until the channel is open.
 */
export default function P2PTransfer() {
    const peerRef = useRef<ManualPeer | null>(null);
    const [offer, setOffer] = useState('');
    const [answer, setAnswer] = useState('');
    const [message, setMessage] = useState('Idle');
    const [peerStatus, setPeerStatus] = useState<ManualPeerStatus>({ connection: 'new', channel: 'none', transport: null });
    const [copied, setCopied] = useState(false);
    const [busy, setBusy] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [sendProgress, setSendProgress] = useState<number | null>(null);
    const [recvProgress, setRecvProgress] = useState<number | null>(null);

    useEffect(() => {
        const peer = new ManualPeer({
            onStatus: setPeerStatus,
            onReceiveProgress: setRecvProgress,
            onFileReceived: (blob, meta) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = meta.name || 'download';
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
                setMessage(`Received ${meta.name} (${blob.size.toLocaleString()} bytes)`);
            },
        });
        peerRef.current = peer;
        return () => {
            peer.close();
            peerRef.current = null;
        };
    }, []);

    const run = async (label: string, fn: (peer: ManualPeer) => Promise<void>) => {
        const peer = peerRef.current;
        if (!peer) return;
        setBusy(true);
        setMessage(label);
        try {
            await fn(peer);
        } catch (e) {
            setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            setBusy(false);
        }
    };

    const handleCreateOffer = () => run('Gathering ICE candidates for offer...', async peer => {
        setAnswer('');
        setOffer(await peer.createOffer());
        setMessage('Offer ready. Send it to the other browser, then paste its answer and press Connect.');
    });

    const handleCreateAnswer = () => run('Gathering ICE candidates for answer...', async peer => {
        setAnswer(await peer.createAnswer(offer));
        setMessage('Answer ready. Send it back to the initiator.');
    });

    const handleAcceptAnswer = () => run('Applying answer...', async peer => {
        await peer.acceptAnswer(answer);
        setMessage('Answer applied. Waiting for the data channel to open...');
    });

    const handleSendFile = () => run('Sending file...', async peer => {
        if (!selectedFile) return;
        setSendProgress(0);
        await peer.sendFile(selectedFile, setSendProgress);
        setMessage(`Sent ${selectedFile.name} (queued to data channel)`);
    });

    const copyToClipboard = async (text: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            setMessage('Clipboard unavailable; copy the text manually.');
        }
    };

    const channelOpen = peerStatus.channel === 'open';

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="glass p-6 rounded-2xl border border-primary/20">
                <div className="flex items-center gap-3 mb-4">
                    <Zap className="w-6 h-6 text-primary" />
                    <h3 className="text-xl font-bold">Direct P2P Transfer</h3>
                </div>

                <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs text-gray-400 uppercase tracking-wider">Offer (initiator)</label>
                            <textarea
                                value={offer}
                                onChange={(e) => setOffer(e.target.value)}
                                placeholder="Create an offer, or paste the one you received..."
                                className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-xs font-mono mt-1 h-24"
                            />
                            <div className="flex gap-2 mt-2">
                                <Button onClick={handleCreateOffer} size="sm" variant="primary" disabled={busy}>
                                    Create Offer
                                </Button>
                                {offer && (
                                    <Button onClick={() => copyToClipboard(offer)} size="sm" variant="secondary">
                                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                    </Button>
                                )}
                            </div>
                        </div>

                        <div>
                            <label className="text-xs text-gray-400 uppercase tracking-wider">Answer (receiver)</label>
                            <textarea
                                value={answer}
                                onChange={(e) => setAnswer(e.target.value)}
                                placeholder="Create an answer from a pasted offer, or paste the answer you received..."
                                className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-xs font-mono mt-1 h-24"
                            />
                            <div className="flex gap-2 mt-2">
                                <Button onClick={handleCreateAnswer} size="sm" variant="primary" disabled={busy || !offer}>
                                    Create Answer
                                </Button>
                                <Button onClick={handleAcceptAnswer} size="sm" variant="success" disabled={busy || !answer}>
                                    Connect
                                </Button>
                                {answer && (
                                    <Button onClick={() => copyToClipboard(answer)} size="sm" variant="secondary">
                                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                    </Button>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="border-t border-white/10 pt-4">
                        <label className="text-xs text-gray-400 uppercase tracking-wider">Send file</label>
                        <div className="flex gap-2 mt-2">
                            <input
                                type="file"
                                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                                className="flex-1 text-sm"
                            />
                            <Button onClick={handleSendFile} disabled={!selectedFile || !channelOpen || busy} variant="primary">
                                Send via P2P
                            </Button>
                        </div>
                        {[['Sending', sendProgress], ['Receiving', recvProgress]].map(([label, value]) =>
                            value === null ? null : (
                                <div className="mt-2" key={label as string}>
                                    <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                                        <motion.div className="h-full bg-primary" initial={{ width: 0 }} animate={{ width: `${value}%` }} />
                                    </div>
                                    <p className="text-xs text-gray-400 mt-1">{label}: {value}%</p>
                                </div>
                            ),
                        )}
                    </div>

                    <div className="bg-black/40 rounded-lg p-3 border border-white/10 space-y-1 text-xs font-mono">
                        <p className="text-primary">{message}</p>
                        <p className="text-gray-400">Peer connection: {peerStatus.connection} · Data channel: {peerStatus.channel}</p>
                        <p className="text-gray-400">Transport: {peerStatus.transport ?? 'not connected'}</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
