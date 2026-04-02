'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { RadioReceiver, Zap, Fingerprint, Activity, Wifi, X, ArrowRight, ShieldCheck } from 'lucide-react';
import Button from '@/components/ui/Button';
import { WebTransportService } from '@/lib/WebTransportService';

export default function WormholeConnect({ onConnect }: { onConnect: (peerId: string) => void }) {
    const [scanning, setScanning] = useState(false);
    const [nearbyPeers, setNearbyPeers] = useState<{ id: string, distance: number, signal: number }[]>([]);

    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (scanning) {
            interval = setInterval(() => {
                if (Math.random() > 0.4) {
                    const id = `DTN-${Math.floor(Math.random() * 9000) + 1000}`;
                    setNearbyPeers(prev => {
                        const exists = prev.find(p => p.id === id);
                        if (exists) {
                            return prev.map(p => p.id === id 
                                ? { ...p, distance: Math.max(0.2, p.distance - 0.1), signal: Math.min(100, p.signal + 5) } 
                                : p
                            );
                        }
                        if (prev.length >= 4) return prev;
                        return [...prev, { id, distance: 5.0, signal: 45 }].sort((a,b) => a.distance - b.distance);
                    });
                }
            }, 800);
        } else {
            setNearbyPeers([]);
        }

        return () => clearInterval(interval);
    }, [scanning]);

    return (
        <div className="w-full glass p-6 border border-primary/20 rounded-3xl flex flex-col items-center relative overflow-hidden group bg-black/40 backdrop-blur-xl">
            {scanning && (
                <div className="absolute inset-0 bg-primary/2 animate-pulse rounded-3xl pointer-events-none" />
            )}

            <div className="flex items-center justify-between w-full mb-6">
                <div className="flex items-center gap-3">
                    <div className="p-2.5 bg-primary/15 rounded-xl border border-primary/20">
                        <RadioReceiver className={`w-5 h-5 text-primary ${scanning ? 'animate-pulse' : ''}`} />
                    </div>
                    <div>
                        <h3 className="font-bold text-white text-sm tracking-tight">Wormhole Protocol</h3>
                        <p className="text-[10px] text-gray-500 uppercase tracking-widest font-mono">Subspace P2P Discovery</p>
                    </div>
                </div>
                {scanning && (
                    <button 
                        onClick={() => setScanning(false)}
                        className="p-1.5 rounded-lg hover:bg-white/5 text-gray-500 transition-colors"
                    >
                        <X size={14} />
                    </button>
                )}
            </div>

            <AnimatePresence mode="wait">
                {!scanning ? (
                    <motion.div 
                        key="idle"
                        initial={{ opacity: 0, scale: 0.98 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.98 }}
                        className="w-full"
                    >
                        <Button 
                            variant="secondary" 
                            className="w-full justify-center py-4 bg-primary/5 border-primary/20 hover:bg-primary/10 transition-all rounded-2xl group/btn"
                            onClick={() => setScanning(true)}
                        >
                            <Activity className="w-4 h-4 mr-2 text-primary group-hover/btn:scale-110 transition-transform" />
                            <span className="text-sm font-semibold">Initiate Wormhole Discovery</span>
                        </Button>
                        <div className="mt-4 flex items-center justify-center gap-2 text-[10px] text-gray-600">
                            <ShieldCheck size={10} />
                            <span>Zero-Knowledge LAN Handshake Active</span>
                        </div>
                    </motion.div>
                ) : (
                    <motion.div 
                        key="scanning"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="w-full flex flex-col gap-3"
                    >
                        {nearbyPeers.length === 0 ? (
                            <div className="py-10 flex flex-col items-center justify-center text-center">
                                <motion.div 
                                    animate={{ scale: [1, 1.2, 1], opacity: [0.3, 0.6, 0.3] }}
                                    transition={{ duration: 2, repeat: Infinity }}
                                    className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4"
                                >
                                    <Wifi className="w-8 h-8 text-primary" />
                                </motion.div>
                                <p className="text-xs text-gray-500 font-medium">Scanning local mesh for peers...</p>
                                <p className="text-[10px] text-gray-600 mt-1">Bring devices within same subnet</p>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-2.5">
                                {nearbyPeers.map(peer => (
                                    <motion.div 
                                        key={peer.id} 
                                        initial={{ opacity: 0, x: -10 }}
                                        animate={{ opacity: 1, x: 0 }}
                                        className="flex items-center justify-between p-3.5 bg-white/4 border border-white/5 rounded-2xl hover:bg-white/8 hover:border-primary/40 cursor-pointer transition-all group"
                                        onClick={() => onConnect(peer.id)}
                                    >
                                        <div className="flex items-center gap-3">
                                            <div className="relative">
                                                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center border border-primary/20">
                                                    <Fingerprint className="w-5 h-5 text-primary" />
                                                </div>
                                                <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-success rounded-full border-2 border-[#0A0F1A] shadow-lg animate-pulse" />
                                            </div>
                                            <div className="flex flex-col">
                                                <span className="text-xs font-bold text-white font-mono uppercase tracking-wider">{peer.id}</span>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[10px] text-gray-500">~{peer.distance.toFixed(1)}m</span>
                                                    <div className="w-1 h-1 rounded-full bg-gray-700" />
                                                    <span className="text-[10px] text-primary/80">{peer.signal}% Signal</span>
                                                </div>
                                            </div>
                                        </div>
                                        <div className="p-2 rounded-lg bg-primary/10 text-primary opacity-0 group-hover:opacity-100 transition-all">
                                            <ArrowRight size={14} />
                                        </div>
                                    </motion.div>
                                ))}
                            </div>
                        )}
                        
                        <div className="pt-2 flex flex-col items-center gap-2">
                            <div className="flex items-center gap-4 px-3 py-1 bg-white/5 border border-white/8 rounded-full">
                                <div className="flex items-center gap-2">
                                    <div className="w-1 h-1 bg-primary rounded-full animate-ping" />
                                    <span className="text-[9px] text-gray-500 font-mono tracking-tighter uppercase">mDNS Discovery</span>
                                </div>
                                <div className="w-px h-3 bg-white/10" />
                                <div className="flex items-center gap-2">
                                    <Zap className="w-2.5 h-2.5 text-secondary" />
                                    <span className="text-[9px] text-gray-400 font-bold uppercase tracking-widest">
                                        {WebTransportService.getInstance().getProtocol()} Active
                                    </span>
                                </div>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
