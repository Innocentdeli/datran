'use client';

import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import StatCard from '@/components/ui/StatCard';
import { Activity, HardDrive, Download, Users } from 'lucide-react';
import { formatFileSize, formatTimestamp } from '@/lib/utils';

interface AdminStats {
    totalFiles: number;
    totalDownloads: number;
    totalStorage: number;
    recentEvents: any[];
}

export default function AdminDashboard() {
    const [stats, setStats] = useState<AdminStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        setLoading(true);
        fetch('/api/admin/stats')
            .then(async (res) => {
                if (res.status === 401) {
                    // Redirect to login if unauthorized
                    window.location.href = '/auth/signin?callbackUrl=/admin';
                    return;
                }
                if (!res.ok) {
                    throw new Error('Failed to fetch intelligence feed');
                }
                return res.json();
            })
            .then(data => {
                if (data) {
                    setStats(data);
                    setLoading(false);
                }
            })
            .catch(err => {
                console.error(err);
                setError(err.message);
                setLoading(false);
            });
    }, []);

    if (loading) {
        return (
            <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center justify-center gap-4">
                <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin" />
                <div className="text-primary animate-pulse font-mono tracking-widest text-sm">
                    ESTABLISHING SECURE UPLINK...
                </div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center justify-center gap-4">
                <div className="text-red-500 font-bold text-xl uppercase tracking-widest flex items-center gap-2">
                    <Activity className="w-6 h-6 animate-pulse" />
                    Connection Severed
                </div>
                <p className="text-gray-500 text-sm font-mono">{error}</p>
                <button
                    onClick={() => window.location.reload()}
                    className="px-6 py-2 bg-white/10 hover:bg-white/20 rounded text-xs uppercase tracking-widest mt-4 transition-colors"
                >
                    Retry Handshake
                </button>
            </div>
        );
    }

    if (!stats) return null;

    // Transform recent events for chart (simple grouping by time/type)
    const chartData = stats.recentEvents.slice(0, 20).reverse().map((e: any) => ({
        name: new Date(e.timestamp).toLocaleTimeString(),
        downloads: e.event_type === 'download' ? 1 : 0,
        views: e.event_type === 'view' ? 1 : 0,
    }));

    return (
        <div className="min-h-screen bg-[#050505] text-white flex flex-col items-center p-4 sm:p-8 font-sans selection:bg-primary/30">
            <Header />

            <main className="w-full max-w-7xl flex-1 flex flex-col gap-8">
                <div className="flex items-center justify-between">
                    <h2 className="text-2xl font-bold tracking-tight flex items-center gap-3">
                        <span className="text-white/40">/</span>
                        Mission Control
                    </h2>
                    <div className="px-3 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-xs font-mono text-red-400 animate-pulse">
                        LIVE FEED
                    </div>
                </div>

                {/* Top Stats */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                    <StatCard
                        label="Total Encoeded"
                        value={stats.totalFiles.toString()}
                        variant="primary"
                        icon={HardDrive}
                    />
                    <StatCard
                        label="Global Downloads"
                        value={stats.totalDownloads.toString()}
                        variant="success"
                        icon={Download}
                    />
                    <StatCard
                        label="Storage Used"
                        value={formatFileSize(stats.totalStorage)}
                        variant="warning"
                        icon={HardDrive}
                    />
                    <StatCard
                        label="Active Nodes"
                        value="12"
                        variant="neutral"
                        icon={Users}
                    />
                </div>

                {/* Charts */}
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 h-[300px]">
                    <div className="lg:col-span-2 bg-white/5 border border-white/10 rounded-2xl p-6 relative overflow-hidden backdrop-blur-sm">
                        <h3 className="text-sm font-bold text-gray-400 mb-4 uppercase tracking-wider">Network Traffic</h3>
                        <div className="h-full w-full absolute inset-0 pt-16 pb-4 px-4">
                            <ResponsiveContainer width="100%" height="100%">
                                <AreaChart data={chartData}>
                                    <defs>
                                        <linearGradient id="colorViews" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="#00F2FF" stopOpacity={0.3} />
                                            <stop offset="95%" stopColor="#00F2FF" stopOpacity={0} />
                                        </linearGradient>
                                    </defs>
                                    <XAxis dataKey="name" hide />
                                    <YAxis hide />
                                    <Tooltip contentStyle={{ backgroundColor: '#000', border: '1px solid #333' }} />
                                    <Area type="monotone" dataKey="views" stroke="#00F2FF" fillOpacity={1} fill="url(#colorViews)" />
                                    <Area type="monotone" dataKey="downloads" stroke="#22c55e" fill="none" />
                                </AreaChart>
                            </ResponsiveContainer>
                        </div>
                    </div>

                    <div className="bg-white/5 border border-white/10 rounded-2xl p-6 overflow-hidden backdrop-blur-sm flex flex-col">
                        <h3 className="text-sm font-bold text-gray-400 mb-4 uppercase tracking-wider">Protocol Distribution</h3>
                        <div className="flex-1 flex items-center justify-center">
                            <div className="text-center">
                                <div className="text-4xl font-black text-primary mb-1">82%</div>
                                <div className="text-xs text-gray-500 uppercase tracking-widest">Multimedia</div>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Live Logs Table */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-sm">
                        <div className="px-6 py-4 border-b border-white/5 bg-black/20">
                            <h3 className="text-sm font-bold text-white uppercase tracking-wider">Access Log Stream</h3>
                        </div>
                        <div className="overflow-x-auto max-h-[400px]">
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="uppercase tracking-wider border-b border-white/5 bg-white/5 font-bold text-[10px] text-gray-400">
                                    <tr>
                                        <th scope="col" className="px-6 py-3">Timestamp</th>
                                        <th scope="col" className="px-6 py-3">Event</th>
                                        <th scope="col" className="px-6 py-3">File</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 text-gray-300 font-mono text-[10px]">
                                    {stats.recentEvents.map((event: any) => (
                                        <tr key={event.id} className="hover:bg-white/5 transition-colors">
                                            <td className="px-6 py-4 opacity-50">{formatTimestamp(new Date(event.timestamp))}</td>
                                            <td className="px-6 py-4">
                                                <span className={`px-1.5 py-0.5 rounded text-[8px] uppercase font-bold border ${event.event_type === 'download' ? 'border-green-500/30 text-green-400 bg-green-500/10' :
                                                    event.event_type === 'upload_complete' ? 'border-yellow-500/30 text-yellow-400 bg-yellow-500/10' :
                                                        'border-blue-500/30 text-blue-400 bg-blue-500/10'
                                                    }`}>
                                                    {event.event_type}
                                                </span>
                                            </td>
                                            <td className="px-6 py-4 max-w-[100px] truncate">{event.original_name || '...'}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Merkle Ledger */}
                    <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-sm shadow-[0_0_50px_rgba(34,197,94,0.05)]">
                        <div className="px-6 py-4 border-b border-primary/20 bg-primary/5 flex items-center justify-between">
                            <h3 className="text-sm font-bold text-primary uppercase tracking-wider flex items-center gap-2">
                                <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                                Blockchain Integrity Ledger
                            </h3>
                            <span className="text-[10px] font-mono text-primary opacity-50">MERKLE_ROOT_V1</span>
                        </div>
                        <div className="overflow-x-auto max-h-[400px]">
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="uppercase tracking-wider border-b border-white/5 bg-white/5 font-bold text-[10px] text-gray-400">
                                    <tr>
                                        <th scope="col" className="px-6 py-3">Block</th>
                                        <th scope="col" className="px-6 py-3">Sig</th>
                                        <th scope="col" className="px-6 py-3">Merkle Hash</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 text-gray-300 font-mono text-[10px]">
                                    {(stats as any).ledgerBlocks?.map((block: any) => (
                                        <tr key={block.index} className="hover:bg-primary/5 transition-colors border-l-2 border-l-transparent hover:border-l-primary">
                                            <td className="px-6 py-4 text-primary font-bold">#{block.index}</td>
                                            <td className="px-6 py-4 opacity-70 italic">{block.signature}</td>
                                            <td className="px-6 py-4 text-gray-500 truncate max-w-[150px]">{block.fileHash}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            {(!(stats as any).ledgerBlocks || (stats as any).ledgerBlocks.length === 0) && (
                                <div className="p-12 text-center text-gray-600 text-xs uppercase tracking-widest font-mono">
                                    Awaiting Network Consensus...
                                </div>
                            )}
                        </div>
                    </div>
                </div>

            </main>
            <Footer />
        </div>
    );
}
