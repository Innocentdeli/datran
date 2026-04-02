'use client';

import { useEffect, useState } from 'react';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import StatCard from '@/components/ui/StatCard';
import { Activity, Globe, Wifi } from 'lucide-react';
import SwarmVisualizer from '@/components/features/SwarmVisualizer';
import P2PTransfer from '@/components/features/P2PTransfer';

export default function NetworkPage() {
    const [nodes] = useState(411);
    const [latency] = useState('12ms');
    const [throughput] = useState('8.4 GB/s');

    return (
        <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center p-4 sm:p-8 font-sans">
            <Header />

            <main className="max-w-7xl w-full flex-1 flex flex-col gap-8">
                <h2 className="text-3xl font-black uppercase italic tracking-tighter">Swarm Network Status</h2>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <StatCard label="Active Nodes" value={nodes.toString()} icon={Globe} variant="primary" />
                    <StatCard label="Mesh Latency" value={latency} icon={Wifi} variant="success" />
                    <StatCard label="Throughput" value={throughput} icon={Activity} />
                </div>

                {/* Phase 32: 3D Swarm Visualizer */}
                <SwarmVisualizer />

                {/* Phase 33: WebRTC P2P Transfer */}
                <div>
                    <h3 className="text-xl font-bold mb-4 flex items-center gap-2">
                        <span className="text-primary">⚡</span>
                        Ephemeral Wormhole (P2P Transfer)
                    </h3>
                    <P2PTransfer />
                </div>
            </main>

            <Footer />
        </div>
    );
}
