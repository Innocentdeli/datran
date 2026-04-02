'use client';

import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Terminal, Cpu, Activity, ShieldCheck, Fingerprint, Zap, Layers, X } from 'lucide-react';

import { LogEntry } from '@/types';

interface Thought {
    id: string;
    text: string;
    type: 'system' | 'neural' | 'security' | 'swarm' | 'user' | 'engine' | 'reactor' | 'error';
    timestamp: number;
}

export default function NeuralConsole({ logs = [] }: { logs?: LogEntry[] }) {
    const [thoughts, setThoughts] = useState<Thought[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);

    const systemThoughts = [
        { text: "Optimizing entropy mapping for upcoming payloads...", type: 'system' },
        { text: "Detecting structural patterns in local mesh topology.", type: 'neural' },
        { text: "Verifying Merkle-root integrity across 411 shards.", type: 'security' },
        { text: "Swarm density increasing in Asia-Pacific region.", type: 'swarm' },
        { text: "Pre-fetching frequently accessed atoms into L3 cache.", type: 'system' },
        { text: "Analyzing semantic correlations between shared code blocks.", type: 'neural' },
        { text: "Hardening DTLS tunnel for ephemeral P2P wormhole.", type: 'security' },
        { text: "Migrating chunk fragments to high-uptime peer nodes.", type: 'swarm' }
    ];

    useEffect(() => {
        if (logs.length > 0) {
            const mappedLogs: Thought[] = logs.map((log, i) => ({
                id: `log-${i}-${log.timestamp.getTime()}`,
                text: log.message,
                type: log.type as any,
                timestamp: log.timestamp.getTime()
            }));
            setThoughts(prev => {
                // Combine and sort by timestamp, keep last 15
                const combined = [...prev, ...mappedLogs].filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
                return combined.sort((a,b) => a.timestamp - b.timestamp).slice(-15);
            });
        }
    }, [logs]);

    useEffect(() => {
        const interval = setInterval(() => {
            const randomThought = systemThoughts[Math.floor(Math.random() * systemThoughts.length)];
            const newThought: Thought = {
                id: `neural-${Math.random().toString(36).substring(7)}`,
                text: randomThought.text,
                type: randomThought.type as any,
                timestamp: Date.now()
            };

            setThoughts(prev => [...prev.slice(-14), newThought].sort((a,b) => a.timestamp - b.timestamp));
        }, 6000);

        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [thoughts]);

    const getTypeIcon = (type: string) => {
        switch (type) {
            case 'system': return <Cpu className="w-3 h-3 text-primary" />;
            case 'neural': return <Terminal className="w-3 h-3 text-purple-400" />;
            case 'security': return <ShieldCheck className="w-3 h-3 text-green-400" />;
            case 'swarm': return <Activity className="w-3 h-3 text-orange-400" />;
            case 'user': return <Fingerprint className="w-3 h-3 text-blue-400" />;
            case 'engine': return <Zap className="w-3 h-3 text-yellow-400" />;
            case 'reactor': return <Layers className="w-3 h-3 text-cyan-400" />;
            case 'error': return <X className="w-3 h-3 text-red-400" />;
            default: return <Activity className="w-3 h-3 text-gray-400" />;
        }
    };

    return (
        <div className="glass bg-black/60 border border-white/5 rounded-xl p-4 h-48 flex flex-col overflow-hidden group">
            <div className="flex items-center justify-between mb-3 border-b border-white/5 pb-2">
                <div className="flex items-center gap-2">
                    <Terminal className="w-4 h-4 text-primary animate-pulse" />
                    <h4 className="text-[10px] font-black uppercase tracking-[0.2em] italic text-gray-400">Neural Console</h4>
                </div>
                <div className="flex gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-red-500/50" />
                    <div className="w-1.5 h-1.5 rounded-full bg-yellow-500/50" />
                    <div className="w-1.5 h-1.5 rounded-full bg-green-500/50" />
                </div>
            </div>

            <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto no-scrollbar scroll-smooth">
                <AnimatePresence mode="popLayout">
                    {thoughts.map((thought) => (
                        <motion.div
                            key={thought.id}
                            initial={{ opacity: 0, x: -10 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, scale: 0.9 }}
                            className="flex items-start gap-3"
                        >
                            <div className="mt-0.5">
                                {getTypeIcon(thought.type)}
                            </div>
                            <div className="flex-1">
                                <p className="text-[11px] font-mono leading-relaxed text-gray-300">
                                    <span className="text-white/20 mr-2">[{new Date(thought.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}]</span>
                                    {thought.text}
                                </p>
                            </div>
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>

            <div className="mt-2 h-0.5 bg-white/5 rounded-full overflow-hidden">
                <motion.div
                    className="h-full bg-primary"
                    animate={{ x: [-100, 400] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
                />
            </div>
        </div>
    );
}
