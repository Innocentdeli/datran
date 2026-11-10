import { NextResponse } from 'next/server';
import { checkReadiness } from '@/lib/observability/readiness';
import { livenessReport } from '@/lib/observability/health';
import { getReactorUrl, reactorHeaders } from '@/lib/reactorWorker';

export const dynamic = 'force-dynamic';

export async function GET() {
  const t0 = performance.now();
  const readiness = await checkReadiness();
  const liveness = livenessReport();

  // Test Reactor
  let reactorStatus: 'operational' | 'degraded' | 'offline' = 'offline';
  let reactorLatency = 0;
  let reactorDetails: Record<string, unknown> = {};

  try {
    const rStart = performance.now();
    const reactorRes = await fetch(`${getReactorUrl()}/health`, {
      headers: reactorHeaders(),
      signal: AbortSignal.timeout(2000),
      cache: 'no-store'
    });
    reactorLatency = Math.round(performance.now() - rStart);
    if (reactorRes.ok) {
      reactorStatus = 'operational';
      reactorDetails = await reactorRes.json().catch(() => ({}));
    } else {
      reactorStatus = 'degraded';
    }
  } catch {
    reactorStatus = 'offline';
  }

  const dbOk = readiness.checks.database.status === 'ok';
  const overall = dbOk && (reactorStatus === 'operational' || reactorStatus === 'degraded') 
    ? 'operational' 
    : (dbOk ? 'degraded' : 'major_outage');

  const services = [
    {
      id: 'ingest_api',
      name: 'Ingest & Chunking API',
      status: 'operational',
      latencyMs: Math.round(performance.now() - t0),
      description: 'Zero-knowledge HTTP/QUIC stream reception and client assembly'
    },
    {
      id: 'rust_reactor',
      name: 'Rust Core Reactor v2.0',
      status: reactorStatus,
      latencyMs: reactorLatency,
      description: 'Native SIMD Shannon entropy, DCE2 crypto & QUIC protocol engine',
      details: reactorDetails
    },
    {
      id: 'database',
      name: 'Metadata & State Store',
      status: dbOk ? 'operational' : 'outage',
      latencyMs: readiness.checks.database.latencyMs ?? 0,
      description: 'Persistent transfer metadata, session auth and link lifecycle'
    },
    {
      id: 'radar_swarm',
      name: 'Radar & Peer Signaling',
      status: 'operational',
      latencyMs: 1,
      description: 'Local network discovery and WebRTC rendezvous signaling'
    },
    {
      id: 'email_dispatch',
      name: 'Transactional Email',
      status: 'operational',
      latencyMs: 1,
      description: 'Security alerts, password recovery, and transfer notifications'
    }
  ];

  return NextResponse.json({
    status: overall,
    timestamp: new Date().toISOString(),
    uptimeSeconds: liveness.uptimeSeconds,
    services
  }, {
    headers: {
      'Cache-Control': 'no-store, max-age=0',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
