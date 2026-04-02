'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import { Zap, Copy, Check } from 'lucide-react';
import { WebRTCService } from '@/lib/WebRTCService';
import Button from '@/components/ui/Button';

export default function P2PTransfer() {
    const [peerId, setPeerId] = useState('');
    const [myId] = useState(() => Math.random().toString(36).substring(7));
    const [offer, setOffer] = useState('');
    const [answer, setAnswer] = useState('');
    const [status, setStatus] = useState<string>('Idle');
    const [copied, setCopied] = useState(false);
    const [selectedFile, setSelectedFile] = useState<File | null>(null);
    const [progress, setProgress] = useState(0);

    const handleCreateOffer = async () => {
        try {
            setStatus('Creating offer...');
            const offerDesc = await WebRTCService.createOffer(peerId || 'peer-1');
            setOffer(JSON.stringify(offerDesc));
            setStatus('Offer created. Share with peer.');
        } catch (e: any) {
            setStatus(`Error: ${e.message}`);
        }
    };

    const handleCreateAnswer = async () => {
        try {
            setStatus('Creating answer...');
            const offerObj = JSON.parse(offer);
            const answerDesc = await WebRTCService.createAnswer(peerId || 'peer-1', offerObj);
            setAnswer(JSON.stringify(answerDesc));
            setStatus('Answer created. Share with initiator.');
        } catch (e: any) {
            setStatus(`Error: ${e.message}`);
        }
    };

    const handleSetAnswer = async () => {
        try {
            setStatus('Setting answer...');
            const answerObj = JSON.parse(answer);
            await WebRTCService.setRemoteAnswer(peerId || 'peer-1', answerObj);
            setStatus('Connected! Ready to transfer.');
        } catch (e: any) {
            setStatus(`Error: ${e.message}`);
        }
    };

    const handleSendFile = async () => {
        if (!selectedFile) return;

        try {
            setStatus('Sending file...');
            setProgress(0);
            await WebRTCService.sendFile(peerId || 'peer-1', selectedFile, (percent) => {
                setProgress(percent);
            });
            setStatus('File sent successfully!');
        } catch (e: any) {
            setStatus(`Error: ${e.message}`);
        }
    };

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Set up file reception
    WebRTCService.setOnFileReceived((blob, metadata) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = metadata.name;
        a.click();
        setStatus(`Received: ${metadata.name}`);
    });

    return (
        <div className="max-w-4xl mx-auto space-y-6">
            <div className="glass p-6 rounded-2xl border border-primary/20">
                <div className="flex items-center gap-3 mb-4">
                    <Zap className="w-6 h-6 text-primary" />
                    <h3 className="text-xl font-bold">Ephemeral Wormhole</h3>
                </div>

                <div className="space-y-4">
                    {/* My ID */}
                    <div>
                        <label className="text-xs text-gray-400 uppercase tracking-wider">Your Peer ID</label>
                        <div className="flex gap-2 mt-1">
                            <input
                                type="text"
                                value={myId}
                                readOnly
                                className="flex-1 bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-sm font-mono"
                            />
                            <Button
                                onClick={() => copyToClipboard(myId)}
                                variant="secondary"
                                size="sm"
                            >
                                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            </Button>
                        </div>
                    </div>

                    {/* Peer ID */}
                    <div>
                        <label className="text-xs text-gray-400 uppercase tracking-wider">Target Peer ID</label>
                        <input
                            type="text"
                            value={peerId}
                            onChange={(e) => setPeerId(e.target.value)}
                            placeholder="Enter peer ID..."
                            className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-sm mt-1"
                        />
                    </div>

                    {/* Offer/Answer Exchange */}
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="text-xs text-gray-400 uppercase tracking-wider">Offer (Initiator)</label>
                            <textarea
                                value={offer}
                                onChange={(e) => setOffer(e.target.value)}
                                placeholder="Paste offer here or create one..."
                                className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-xs font-mono mt-1 h-24"
                            />
                            <div className="flex gap-2 mt-2">
                                <Button onClick={handleCreateOffer} size="sm" variant="primary">
                                    Create Offer
                                </Button>
                                {offer && (
                                    <Button onClick={() => copyToClipboard(offer)} size="sm" variant="secondary">
                                        Copy
                                    </Button>
                                )}
                            </div>
                        </div>

                        <div>
                            <label className="text-xs text-gray-400 uppercase tracking-wider">Answer (Receiver)</label>
                            <textarea
                                value={answer}
                                onChange={(e) => setAnswer(e.target.value)}
                                placeholder="Paste answer here or create one..."
                                className="w-full bg-black/40 border border-white/10 rounded-lg px-4 py-2 text-xs font-mono mt-1 h-24"
                            />
                            <div className="flex gap-2 mt-2">
                                <Button onClick={handleCreateAnswer} size="sm" variant="primary">
                                    Create Answer
                                </Button>
                                <Button onClick={handleSetAnswer} size="sm" variant="success">
                                    Connect
                                </Button>
                            </div>
                        </div>
                    </div>

                    {/* File Transfer */}
                    <div className="border-t border-white/10 pt-4">
                        <label className="text-xs text-gray-400 uppercase tracking-wider">Send File (Zero-Trace)</label>
                        <div className="flex gap-2 mt-2">
                            <input
                                type="file"
                                onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                                className="flex-1 text-sm"
                            />
                            <Button onClick={handleSendFile} disabled={!selectedFile} variant="primary">
                                Send via P2P
                            </Button>
                        </div>
                        {progress > 0 && (
                            <div className="mt-2">
                                <div className="h-2 bg-black/40 rounded-full overflow-hidden">
                                    <motion.div
                                        className="h-full bg-primary"
                                        initial={{ width: 0 }}
                                        animate={{ width: `${progress}%` }}
                                    />
                                </div>
                                <p className="text-xs text-gray-400 mt-1">{progress}%</p>
                            </div>
                        )}
                    </div>

                    {/* Status */}
                    <div className="bg-black/40 rounded-lg p-3 border border-white/10">
                        <p className="text-xs font-mono text-primary">{status}</p>
                    </div>
                </div>
            </div>
        </div>
    );
}
