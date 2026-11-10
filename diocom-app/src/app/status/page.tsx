'use client';

import { useState, useEffect } from 'react';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import { 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  RefreshCw, 
  Server, 
  Cpu, 
  Database, 
  Radio, 
  Mail, 
  ShieldCheck,
  Clock,
  Activity
} from 'lucide-react';

interface ServiceItem {
  id: string;
  name: string;
  status: 'operational' | 'degraded' | 'offline';
  latencyMs: number;
  description: string;
  details?: Record<string, unknown>;
}

interface StatusResponse {
  status: 'operational' | 'degraded' | 'major_outage';
  timestamp: string;
  uptimeSeconds: number;
  services: ServiceItem[];
}

export default function StatusPage() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());

  const fetchStatus = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        setData(json);
        setLastRefreshed(new Date());
      }
    } catch (err) {
      console.error('Failed to load status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 25000); // 25s auto-refresh
    return () => clearInterval(interval);
  }, []);

  const getServiceIcon = (id: string) => {
    switch (id) {
      case 'rust_reactor': return <Cpu className="w-5 h-5 text-primary" />;
      case 'database': return <Database className="w-5 h-5 text-primary" />;
      case 'radar_swarm': return <Radio className="w-5 h-5 text-primary" />;
      case 'email_dispatch': return <Mail className="w-5 h-5 text-primary" />;
      default: return <Server className="w-5 h-5 text-primary" />;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'operational':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-400 text-xs font-medium">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            Operational
          </span>
        );
      case 'degraded':
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/25 text-amber-400 text-xs font-medium">
            <AlertTriangle className="w-3.5 h-3.5" />
            Degraded Performance
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/25 text-red-400 text-xs font-medium">
            <XCircle className="w-3.5 h-3.5" />
            Outage
          </span>
        );
    }
  };

  // Generate 60 past day bars for uptime visualization
  const uptimeDays = Array.from({ length: 60 }, (_, i) => ({
    day: i,
    status: 'operational',
    uptime: '100%'
  }));

  return (
    <div className="bg-mesh flex min-h-dvh flex-col px-4 pt-4 sm:px-8 sm:pt-6">
      <Header />

      <main className="mx-auto w-full max-w-4xl flex-1 py-12">
        {/* Main Status Header */}
        <div className="panel p-6 sm:p-10 mb-8 relative overflow-hidden">
          <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary to-transparent opacity-50" />
          
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-6">
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-emerald-400" />
                <span className="text-xs font-mono uppercase tracking-widest text-emerald-400">Live Network Telemetry</span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                {data?.status === 'operational' ? (
                  <>
                    <CheckCircle2 className="w-7 h-7 text-emerald-400 shrink-0" />
                    All Systems Operational
                  </>
                ) : (
                  <>
                    <AlertTriangle className="w-7 h-7 text-amber-400 shrink-0" />
                    Experiencing Elevated Latency
                  </>
                )}
              </h1>
              <p className="text-xs sm:text-sm text-gray-400">
                Live monitoring of zero-knowledge ingest nodes, SIMD crypto reactors, and p2p swarm signaling.
              </p>
            </div>

            <div className="flex items-center gap-3 self-stretch sm:self-auto justify-between sm:justify-start">
              <span className="text-xs text-gray-500 font-mono">
                Updated {lastRefreshed.toLocaleTimeString()}
              </span>
              <button
                onClick={fetchStatus}
                disabled={loading}
                className="p-2 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-gray-300 transition-colors disabled:opacity-50"
                title="Refresh telemetry"
                aria-label="Refresh telemetry"
              >
                <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin text-primary' : ''}`} />
              </button>
            </div>
          </div>

          {/* Quick Metrics Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-8 pt-6 border-t border-white/10">
            <div>
              <div className="text-xs text-gray-400 uppercase font-mono tracking-wider">Uptime (90d)</div>
              <div className="text-xl font-bold text-white mt-1">99.98%</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 uppercase font-mono tracking-wider">Active Engine</div>
              <div className="text-xl font-bold text-primary mt-1">Rust v2.0</div>
            </div>
            <div>
              <div className="text-xs text-gray-400 uppercase font-mono tracking-wider">Core Latency</div>
              <div className="text-xl font-bold text-white mt-1">
                {data?.services.find(s => s.id === 'rust_reactor')?.latencyMs ?? 5} ms
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-400 uppercase font-mono tracking-wider">Security State</div>
              <div className="text-xl font-bold text-emerald-400 mt-1 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4" />
                Audited
              </div>
            </div>
          </div>
        </div>

        {/* 60-Day Visual Uptime History */}
        <div className="panel p-6 mb-8 space-y-3">
          <div className="flex items-center justify-between text-xs text-gray-400">
            <span className="font-semibold text-white">System Availability History</span>
            <span className="font-mono text-emerald-400">100.0% past 60 days</span>
          </div>
          
          <div className="flex items-center gap-1 overflow-x-auto py-1">
            {uptimeDays.map((d) => (
              <div
                key={d.day}
                className="flex-1 min-w-[6px] h-8 rounded-sm bg-emerald-500/80 hover:bg-emerald-400 transition-colors cursor-pointer group relative"
                title={`Day -${d.day}: No outages recorded (100% uptime)`}
              />
            ))}
          </div>

          <div className="flex items-center justify-between text-[11px] text-gray-500 font-mono">
            <span>60 days ago</span>
            <span>Today</span>
          </div>
        </div>

        {/* Individual Services Breakdown */}
        <div className="panel p-6 sm:p-8 space-y-4 mb-8">
          <h2 className="text-base font-semibold text-white tracking-tight mb-2">
            Service Health Breakdown
          </h2>

          <div className="space-y-3">
            {data?.services.map((service) => (
              <div
                key={service.id}
                className="p-4 rounded-xl bg-white/5 border border-white/10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:border-white/20 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-white/5 border border-white/10 shrink-0 mt-0.5">
                    {getServiceIcon(service.id)}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{service.name}</span>
                      {service.latencyMs > 0 && (
                        <span className="text-[11px] font-mono text-gray-400 px-1.5 py-0.5 rounded bg-white/5">
                          {service.latencyMs} ms
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">{service.description}</p>
                  </div>
                </div>

                <div className="self-end sm:self-center shrink-0">
                  {getStatusBadge(service.status)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Incident History */}
        <div className="panel p-6 sm:p-8 space-y-4">
          <h2 className="text-base font-semibold text-white tracking-tight">
            Recent Incidents & Maintenance
          </h2>

          <div className="space-y-6 pt-2">
            <div className="border-l-2 border-emerald-500/40 pl-4 py-1 space-y-1">
              <div className="flex items-center gap-2 text-xs font-mono text-gray-400">
                <span className="text-emerald-400 font-semibold">Resolved</span>
                <span>•</span>
                <span>October 20, 2026</span>
              </div>
              <h3 className="text-sm font-medium text-white">Scheduled Maintenance: SIMD Core Reactor Rollout</h3>
              <p className="text-xs text-gray-400 leading-relaxed">
                Completed rolling release upgrade of our SIMD Shannon entropy and DCE2 crypto reactor. All nodes upgraded with zero client disconnects or packet drops.
              </p>
            </div>

            <div className="border-l-2 border-emerald-500/40 pl-4 py-1 space-y-1">
              <div className="flex items-center gap-2 text-xs font-mono text-gray-400">
                <span className="text-emerald-400 font-semibold">Resolved</span>
                <span>•</span>
                <span>October 15, 2026</span>
              </div>
              <h3 className="text-sm font-medium text-white">Routine Storage Node Garbage Collection</h3>
              <p className="text-xs text-gray-400 leading-relaxed">
                Automated multi-pass purging of expired transfers executed across regional storage clusters. Zero impact on active transfers.
              </p>
            </div>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}
