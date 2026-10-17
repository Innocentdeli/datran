'use client';

import { useEffect, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, BarChart, Bar } from 'recharts';
import Header from '@/components/layout/Header';
import Footer from '@/components/layout/Footer';
import StatCard from '@/components/ui/StatCard';
import { Activity, HardDrive, Download, Users, Dna, Radar, Database } from 'lucide-react';
import { formatFileSize, formatTimestamp } from '@/lib/utils';

interface AdminStats {
    totalFiles: number;
    totalDownloads: number;
    totalStorage: number;
    recentEvents: any[];
}

// ---------------------------------------------------------------------------
// Compression Evolution (Rust reactor /evolution/status via /api/admin/evolution).
// The reactor's payload shape is evolving, so every field is optional and read defensively.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const pick = (o: Json | null | undefined, ...keys: string[]): unknown => {
    if (!o) return undefined;
    for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
    return undefined;
};
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
const fmt = (v: unknown, digits = 2, suffix = ''): string => { const n = num(v); return n === null ? '—' : `${n.toFixed(digits)}${suffix}`; };
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : typeof v === 'number' ? String(v) : null);

interface EvolutionClassRow {
    name: string;
    generation: unknown;
    recipe: Json | null;
    fitness: unknown;
    ratio: unknown;
    encMiBs: unknown;
    decMiBs: unknown;
    samples: unknown;
    population: unknown;
}

function parseRecipe(v: unknown): Json | null {
    if (isObj(v)) return v;
    if (typeof v === 'string') {
        try { const p = JSON.parse(v); return isObj(p) ? p : null; } catch { return null; }
    }
    return null;
}

function parseClasses(data: Json): EvolutionClassRow[] {
    const raw = pick(data, 'classes', 'populations', 'per_class');
    const entries: Array<[string, Json]> = Array.isArray(raw)
        ? raw.filter(isObj).map((c, i) => [str(pick(c, 'class', 'name', 'id')) ?? `class ${i + 1}`, c])
        : isObj(raw) ? Object.entries(raw).filter((e): e is [string, Json] => isObj(e[1])) : [];
    return entries.map(([name, c]) => {
        const champ = isObj(pick(c, 'champion')) ? (pick(c, 'champion') as Json) : null;
        const recipe = parseRecipe(pick(champ, 'recipe') ?? pick(c, 'recipe', 'champion_recipe'));
        const both = (...keys: string[]) => pick(champ, ...keys) ?? pick(c, ...keys);
        return {
            name,
            generation: pick(c, 'generation', 'gen', 'generations'),
            recipe,
            fitness: both('fitness'),
            ratio: both('ratio', 'compression_ratio'),
            encMiBs: both('enc_mib_s', 'encode_mib_s', 'enc_mibps', 'encode_mibps', 'enc_speed_mib_s'),
            decMiBs: both('dec_mib_s', 'decode_mib_s', 'dec_mibps', 'decode_mibps', 'dec_speed_mib_s'),
            samples: pick(c, 'samples', 'sample_count', 'reservoir', 'reservoir_size'),
            population: pick(c, 'population', 'population_size'),
        };
    });
}

function recipeLabel(r: Json | null): { codec: string; level: string; filter: string; dict: boolean } | null {
    if (!r) return null;
    const codec = str(pick(r, 'codec')) ?? '?';
    const level = num(pick(r, 'level'));
    const wl = num(pick(r, 'window_log'));
    const filter = str(pick(r, 'filter')) ?? 'none';
    const stride = num(pick(r, 'stride'));
    return {
        codec,
        level: [level !== null ? `L${level}` : null, wl !== null ? `w${wl}` : null].filter(Boolean).join(' ') || '—',
        filter: filter === 'none' ? 'none' : `${filter}${stride ? `/${stride}` : ''}`,
        dict: !!str(pick(r, 'dict')),
    };
}

function formatWhen(v: unknown): string | null {
    const n = num(v);
    if (n !== null) {
        const ms = n < 1e12 ? n * 1000 : n; // seconds or milliseconds since epoch
        return new Date(ms).toLocaleString();
    }
    return str(v);
}

function EvolutionPanel() {
    const [data, setData] = useState<Json | null>(null);
    const [status, setStatus] = useState<'loading' | 'ok' | 'offline' | 'error'>('loading');
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            fetch('/api/admin/evolution', { cache: 'no-store' })
                .then(async (res) => {
                    const body = await res.json().catch(() => null);
                    if (cancelled) return;
                    if (res.ok && isObj(body)) {
                        setData(body);
                        setStatus('ok');
                        setMessage(null);
                    } else {
                        setStatus(res.status === 503 ? 'offline' : 'error');
                        setMessage(isObj(body) ? str(body.error) : `HTTP ${res.status}`);
                    }
                })
                .catch((err: unknown) => {
                    if (cancelled) return;
                    setStatus('error');
                    setMessage(err instanceof Error ? err.message : String(err));
                });
        };
        load();
        const timer = setInterval(load, 15_000);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);

    const classes = data ? parseClasses(data) : [];
    const peersRaw = data ? pick(data, 'peers') : undefined;
    const peers = Array.isArray(peersRaw) ? peersRaw.filter(isObj) : [];
    const weights = data && isObj(pick(data, 'weights')) ? (pick(data, 'weights') as Json) : null;
    const evolving = data ? pick(data, 'evolve', 'evolving', 'enabled') : undefined;

    return (
        <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-sm">
            <div className="px-6 py-4 border-b border-white/5 bg-black/20 flex items-center justify-between gap-4 flex-wrap">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <Dna className="w-4 h-4 text-primary" />
                    Compression Evolution
                </h3>
                <div className="flex items-center gap-3 text-[10px] font-mono text-gray-500">
                    {weights && (
                        <span>W_enc {fmt(pick(weights, 'encode', 'enc', 'w_enc'), 2)} · W_dec {fmt(pick(weights, 'decode', 'dec', 'w_dec'), 2)}</span>
                    )}
                    {evolving === false && <span className="text-yellow-400">FROZEN</span>}
                    <span className={`px-2 py-0.5 rounded border uppercase font-bold ${status === 'ok' ? 'border-green-500/30 text-green-400 bg-green-500/10' :
                        status === 'loading' ? 'border-white/10 text-gray-400' :
                            'border-red-500/30 text-red-400 bg-red-500/10'
                        }`}>
                        {status === 'ok' ? 'Reactor online' : status === 'loading' ? 'Loading' : status === 'offline' ? 'Reactor offline' : 'Error'}
                    </span>
                </div>
            </div>

            {status !== 'ok' && status !== 'loading' && (
                <div className="p-12 text-center text-gray-600 text-xs uppercase tracking-widest font-mono">
                    {message || 'Evolution status unavailable'}
                </div>
            )}

            {status === 'ok' && (
                <>
                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead className="uppercase tracking-wider border-b border-white/5 bg-white/5 font-bold text-[10px] text-gray-400">
                                <tr>
                                    <th scope="col" className="px-6 py-3">Class</th>
                                    <th scope="col" className="px-6 py-3">Gen</th>
                                    <th scope="col" className="px-6 py-3">Codec</th>
                                    <th scope="col" className="px-6 py-3">Level</th>
                                    <th scope="col" className="px-6 py-3">Filter</th>
                                    <th scope="col" className="px-6 py-3">Dict</th>
                                    <th scope="col" className="px-6 py-3">Ratio</th>
                                    <th scope="col" className="px-6 py-3">Enc MiB/s</th>
                                    <th scope="col" className="px-6 py-3">Dec MiB/s</th>
                                    <th scope="col" className="px-6 py-3">Fitness</th>
                                    <th scope="col" className="px-6 py-3">Samples</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5 text-gray-300 font-mono text-[10px]">
                                {classes.map((c) => {
                                    const r = recipeLabel(c.recipe);
                                    return (
                                        <tr key={c.name} className="hover:bg-white/5 transition-colors">
                                            <td className="px-6 py-4 text-primary font-bold">{c.name}</td>
                                            <td className="px-6 py-4">{fmt(c.generation, 0)}</td>
                                            <td className="px-6 py-4 uppercase">{r?.codec ?? '—'}</td>
                                            <td className="px-6 py-4">{r?.level ?? '—'}</td>
                                            <td className="px-6 py-4">{r?.filter ?? '—'}</td>
                                            <td className="px-6 py-4">{r ? (r.dict ? 'yes' : 'no') : '—'}</td>
                                            <td className="px-6 py-4">{fmt(c.ratio, 2, 'x')}</td>
                                            <td className="px-6 py-4">{fmt(c.encMiBs, 1)}</td>
                                            <td className="px-6 py-4">{fmt(c.decMiBs, 1)}</td>
                                            <td className="px-6 py-4">{fmt(c.fitness, 3)}</td>
                                            <td className="px-6 py-4">
                                                {fmt(c.samples, 0)}
                                                {num(c.population) !== null && <span className="opacity-40"> / pop {fmt(c.population, 0)}</span>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {classes.length === 0 && (
                            <div className="p-12 text-center text-gray-600 text-xs uppercase tracking-widest font-mono">
                                No content classes yet — awaiting uploads
                            </div>
                        )}
                    </div>

                    <div className="border-t border-white/5">
                        <div className="px-6 py-3 bg-white/5 font-bold text-[10px] text-gray-400 uppercase tracking-wider">
                            Peers ({peers.length})
                        </div>
                        {peers.length === 0 ? (
                            <div className="px-6 py-4 text-gray-600 text-[10px] uppercase tracking-widest font-mono">No peers configured</div>
                        ) : (
                            <div className="overflow-x-auto">
                                <table className="w-full text-left text-sm whitespace-nowrap">
                                    <tbody className="divide-y divide-white/5 text-gray-300 font-mono text-[10px]">
                                        {peers.map((p, i) => {
                                            const lastErr = str(pick(p, 'last_error', 'error'));
                                            const lastOk = formatWhen(pick(p, 'last_ok', 'last_success', 'last_ok_at'));
                                            return (
                                                <tr key={str(pick(p, 'url')) ?? i} className="hover:bg-white/5 transition-colors">
                                                    <td className="px-6 py-3">{str(pick(p, 'url')) ?? '?'}</td>
                                                    <td className="px-6 py-3">
                                                        <span className={`px-1.5 py-0.5 rounded text-[8px] uppercase font-bold border ${lastErr ? 'border-red-500/30 text-red-400 bg-red-500/10' : lastOk ? 'border-green-500/30 text-green-400 bg-green-500/10' : 'border-white/10 text-gray-400'}`}>
                                                            {lastErr ? 'error' : lastOk ? 'ok' : 'pending'}
                                                        </span>
                                                    </td>
                                                    <td className="px-6 py-3 opacity-50">{lastOk ? `last ok ${lastOk}` : '—'}</td>
                                                    <td className="px-6 py-3 text-red-400/80 truncate max-w-[300px]" title={lastErr ?? undefined}>{lastErr ?? ''}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Reactor object store (NETWORK_SPEC §2) + cluster (§4) via /api/admin/store. Fields read defensively.
// ---------------------------------------------------------------------------

type StorePart = { status: 'ok'; data: Json } | { status: 'unavailable' | 'error'; error: string };

function StoreMetric({ label, value, sub }: { label: string; value: string; sub?: string | null }) {
    return (
        <div className="px-6 py-4">
            <div className="text-[10px] uppercase tracking-wider text-gray-500 font-bold">{label}</div>
            <div className="text-lg font-mono text-white mt-1">{value}</div>
            {sub && <div className="text-[10px] font-mono text-gray-500 mt-0.5">{sub}</div>}
        </div>
    );
}

const fmtBytes = (v: unknown): string => { const n = num(v); return n === null ? '—' : formatFileSize(n); };

function StorePanel() {
    const [backend, setBackend] = useState<string | null>(null);
    const [store, setStore] = useState<StorePart | null>(null);
    const [cluster, setCluster] = useState<StorePart | null>(null);
    const [status, setStatus] = useState<'loading' | 'ok' | 'offline' | 'error'>('loading');
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            fetch('/api/admin/store', { cache: 'no-store' })
                .then(async (res) => {
                    const body = await res.json().catch(() => null);
                    if (cancelled) return;
                    if (isObj(body)) setBackend(str(body.backend));
                    if (res.ok && isObj(body)) {
                        setStore(isObj(body.store) ? (body.store as StorePart) : null);
                        setCluster(isObj(body.cluster) ? (body.cluster as StorePart) : null);
                        setStatus('ok');
                        setMessage(null);
                    } else {
                        setStatus(res.status === 503 ? 'offline' : 'error');
                        setMessage(isObj(body) ? str(body.error) : `HTTP ${res.status}`);
                    }
                })
                .catch((err: unknown) => {
                    if (cancelled) return;
                    setStatus('error');
                    setMessage(err instanceof Error ? err.message : String(err));
                });
        };
        load();
        const timer = setInterval(load, 15_000);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);

    const s = store?.status === 'ok' ? store.data : null;
    const fusion = s && isObj(s.fusion) ? (s.fusion as Json) : null;
    const scrub = s && isObj(s.scrub) ? (s.scrub as Json) : null;
    const gc = s && isObj(s.gc) ? (s.gc as Json) : null;
    const c = cluster?.status === 'ok' ? cluster.data : null;
    const peersRaw = c ? pick(c, 'peers') : undefined;
    const peers = Array.isArray(peersRaw) ? peersRaw.filter(isObj) : [];
    const maxBytes = s ? num(s.max_bytes) : null;
    const live = s ? num(pick(s, 'live_physical_bytes', 'physical_bytes')) : null;

    return (
        <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-sm">
            <div className="px-6 py-4 border-b border-white/5 bg-black/20 flex items-center justify-between gap-4 flex-wrap">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <Database className="w-4 h-4 text-primary" />
                    Object Store
                </h3>
                <div className="flex items-center gap-3 text-[10px] font-mono text-gray-500">
                    {backend && <span>uploads → <span className={backend === 'reactor' ? 'text-primary' : 'text-gray-300'}>{backend}</span></span>}
                    <span className={`px-2 py-0.5 rounded border uppercase font-bold ${status === 'ok' && s ? 'border-green-500/30 text-green-400 bg-green-500/10' :
                        status === 'loading' ? 'border-white/10 text-gray-400' :
                            'border-red-500/30 text-red-400 bg-red-500/10'
                        }`}>
                        {status === 'loading' ? 'Loading' : status === 'offline' ? 'Reactor offline' : status === 'error' ? 'Error' : s ? 'Store online' : 'Store disabled'}
                    </span>
                </div>
            </div>

            {status !== 'ok' && status !== 'loading' && (
                <div className="p-12 text-center text-gray-600 text-xs uppercase tracking-widest font-mono">
                    {message || 'Store status unavailable'}
                </div>
            )}

            {status === 'ok' && !s && (
                <div className="p-8 text-center text-gray-600 text-xs uppercase tracking-widest font-mono">
                    {store && store.status !== 'ok' ? store.error : 'No store statistics'}
                </div>
            )}

            {s && (
                <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-y divide-white/5 border-b border-white/5">
                    <StoreMetric label="Files" value={fmt(s.files, 0)} sub={`${fmt(s.chunks, 0)} chunks · ${fmt(s.objects, 0)} objects`} />
                    <StoreMetric label="Logical" value={fmtBytes(s.logical_bytes)} sub={`unique ${fmtBytes(s.unique_bytes)}`} />
                    <StoreMetric label="Physical" value={fmtBytes(live)}
                        sub={maxBytes ? `of ${formatFileSize(maxBytes)}${live !== null ? ` (${((live / maxBytes) * 100).toFixed(1)}%)` : ''}` : 'no cap'} />
                    <StoreMetric label="Ratios" value={fmt(s.total_ratio, 2, 'x')} sub={`dedup ${fmt(s.dedup_ratio, 2, 'x')} · codec ${fmt(s.compression_ratio, 2, 'x')}`} />
                    <StoreMetric label="Fusion" value={fusion ? `${fmt(fusion.fusions, 0)} fused / ${fmt(fusion.unfusions, 0)} split` : '—'}
                        sub={fusion ? `${fusion.enabled === false ? 'disabled · ' : ''}${fmt(s.super_chunks, 0)} super-chunks · saved ${fmtBytes(fusion.bytes_saved)} · ${fmt(fusion.reads_saved, 0)} reads` : null} />
                    <StoreMetric label="Scrub" value={scrub ? `${fmt(scrub.passes_completed, 0)} passes` : '—'}
                        sub={scrub ? `${fmt(scrub.objects_checked, 0)} checked · ${fmt(scrub.corrupt_found, 0)} corrupt · ${fmt(scrub.quarantined, 0)} quarantined` : null} />
                    <StoreMetric label="GC queue" value={gc ? fmtBytes(gc.queue_bytes) : '—'} sub={gc ? `${fmt(gc.queue_objects, 0)} objects · collected ${fmtBytes(gc.collected_bytes)}` : null} />
                    <StoreMetric label="Traffic" value={`${fmt(s.puts, 0)} puts · ${fmt(s.reads, 0)} reads`}
                        sub={`in ${fmtBytes(s.put_bytes)} · out ${fmtBytes(s.read_bytes)} · ${fmt(s.full_rejections, 0)} rejected (full)`} />
                </div>
            )}

            {status === 'ok' && (
                <div>
                    <div className="px-6 py-3 bg-white/5 font-bold text-[10px] text-gray-400 uppercase tracking-wider flex justify-between gap-4">
                        <span>Cluster</span>
                        {c && <span className="font-mono normal-case">{str(pick(c, 'node_id')) ?? ''}{str(pick(c, 'region')) ? ` · ${str(pick(c, 'region'))}` : ''}</span>}
                    </div>
                    {!c ? (
                        <div className="px-6 py-4 text-gray-600 text-[10px] uppercase tracking-widest font-mono">
                            {cluster && cluster.status !== 'ok' ? `Cluster status unavailable (${cluster.error})` : 'Cluster status unavailable'}
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            {peers.length === 0 ? (
                                <div className="px-6 py-4 text-gray-600 text-[10px] uppercase tracking-widest font-mono">No peers</div>
                            ) : (
                                <table className="w-full text-left text-sm whitespace-nowrap">
                                    <tbody className="divide-y divide-white/5 text-gray-300 font-mono text-[10px]">
                                        {peers.map((p, i) => {
                                            const err = str(pick(p, 'last_error', 'error'));
                                            return (
                                                <tr key={str(pick(p, 'node_id', 'url')) ?? i} className="hover:bg-white/5 transition-colors">
                                                    <td className="px-6 py-3">{str(pick(p, 'node_id')) ?? '—'}</td>
                                                    <td className="px-6 py-3">{str(pick(p, 'url')) ?? ''}</td>
                                                    <td className="px-6 py-3">{str(pick(p, 'region')) ?? ''}</td>
                                                    <td className="px-6 py-3 opacity-60">{num(pick(p, 'used')) !== null ? `${fmtBytes(pick(p, 'used'))} used` : ''}</td>
                                                    <td className="px-6 py-3 text-red-400/80 truncate max-w-[300px]" title={err ?? undefined}>{err ?? ''}</td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            )}
                            <details className="px-6 py-3 text-[10px] font-mono text-gray-500">
                                <summary className="cursor-pointer uppercase tracking-wider">Raw cluster status</summary>
                                <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(c, null, 2)}</pre>
                            </details>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Access Prediction (NETWORK_SPEC §5) via /api/admin/prediction. All numbers are measured in this server process
// (metrics reset on restart; the model itself is rebuilt from persisted access events).
// ---------------------------------------------------------------------------

interface RateSummary { numerator: number; denominator: number; rate: number | null }
interface PctStats { count: number; p50: number | null; p95: number | null }
interface PredictionStatus {
    enabled: boolean;
    ready: boolean;
    config: { windowMs: number; minScore: number; successorsK: number; intervalMs: number; prefetchMaxBytes: number; cacheMaxBytes: number; concurrency: number };
    model: { trackedFiles: number; trackedActors: number; observedEvents: number; rebuiltEvents: number; rebuildError: string | null };
    metrics: {
        horizonMs: number;
        precision: Record<'temporal' | 'sequential' | 'intent' | 'all', RateSummary>;
        recall: RateSummary;
        openPredictions: number;
        hitRate: { predicted: RateSummary; unpredicted: RateSummary; all: RateSummary };
        ttfbMs: Record<'hit' | 'miss' | 'disk', PctStats>;
    };
    cache: { entries: number; bytes: number; maxBytes: number; prefetchBytes: number; prefetchMaxBytes: number; prefetchInserted: Record<string, number>; prefetchHits: Record<string, number>; prefetchWasted: Record<string, number> };
    prefetch: { ticks: number; lastTickAt: number | null; warmed: Record<string, number>; warmedBytes: number; warmFailed: number; warmSkipped: Record<string, number>; queue: number; active: number; lastWarmError: string | null };
    events: { written: number; pending: number; dropped: number; writeErrors: number; retentionDays: number; lastError: string | null };
    topPredictions: { shareId: string; name: string | null; score: number; lambdaTemporal: number; lambdaRecency: number; selected: boolean; cached: boolean }[];
}

const pctOf = (r: RateSummary | undefined) => (r && r.rate !== null ? `${(r.rate * 100).toFixed(1)}%` : '—');
const fracOf = (r: RateSummary | undefined) => (r ? `${r.numerator}/${r.denominator}` : '');
const msOf = (v: number | null | undefined) => (typeof v === 'number' ? `${v < 10 ? v.toFixed(2) : v.toFixed(0)} ms` : '—');
const sumOf = (o: Record<string, number> | undefined) => Object.values(o || {}).reduce((a, b) => a + b, 0);
const durOf = (ms: number) => (ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)}h` : `${Math.round(ms / 60_000)}m`);

function MetricTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="px-6 py-4">
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">{label}</div>
            <div className="text-xl font-black text-white mt-1 font-mono">{value}</div>
            {sub && <div className="text-[10px] font-mono text-gray-500 mt-0.5">{sub}</div>}
        </div>
    );
}

function PredictionPanel() {
    const [data, setData] = useState<PredictionStatus | null>(null);
    const [status, setStatus] = useState<'loading' | 'ok' | 'error'>('loading');
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        const load = () => {
            fetch('/api/admin/prediction', { cache: 'no-store' })
                .then(async (res) => {
                    const body = await res.json().catch(() => null);
                    if (cancelled) return;
                    if (res.ok && isObj(body) && isObj(body.metrics)) {
                        setData(body as unknown as PredictionStatus);
                        setStatus('ok');
                        setMessage(null);
                    } else {
                        setStatus('error');
                        setMessage(isObj(body) ? str(body.error) : `HTTP ${res.status}`);
                    }
                })
                .catch((err: unknown) => {
                    if (cancelled) return;
                    setStatus('error');
                    setMessage(err instanceof Error ? err.message : String(err));
                });
        };
        load();
        const timer = setInterval(load, 15_000);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);

    const m = data?.metrics;
    const badge = !data ? (status === 'loading' ? 'Loading' : 'Error') : !data.enabled ? 'Disabled' : data.ready ? 'Model ready' : 'Rebuilding';
    const badgeClass = data?.enabled && data.ready
        ? 'border-green-500/30 text-green-400 bg-green-500/10'
        : status === 'loading'
            ? 'border-white/10 text-gray-400'
            : data?.enabled
                ? 'border-yellow-500/30 text-yellow-400 bg-yellow-500/10'
                : 'border-red-500/30 text-red-400 bg-red-500/10';

    return (
        <div className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-sm">
            <div className="px-6 py-4 border-b border-white/5 bg-black/20 flex items-center justify-between gap-4 flex-wrap">
                <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                    <Radar className="w-4 h-4 text-primary" />
                    Access Prediction
                </h3>
                <div className="flex items-center gap-3 text-[10px] font-mono text-gray-500">
                    {data && m && (
                        <span>
                            window {durOf(data.config.windowMs)} · min P {data.config.minScore} · k={data.config.successorsK} · metrics over {durOf(m.horizonMs)}
                        </span>
                    )}
                    <span className={`px-2 py-0.5 rounded border uppercase font-bold ${badgeClass}`}>{badge}</span>
                </div>
            </div>

            {status === 'error' && !data && (
                <div className="p-12 text-center text-gray-600 text-xs uppercase tracking-widest font-mono">
                    {message || 'Prediction status unavailable'}
                </div>
            )}

            {data && m && (
                <>
                    <div className="grid grid-cols-2 lg:grid-cols-4 divide-x divide-y lg:divide-y-0 divide-white/5 border-b border-white/5">
                        <MetricTile
                            label="Precision"
                            value={pctOf(m.precision.all)}
                            sub={`${fracOf(m.precision.all)} closed · temporal ${pctOf(m.precision.temporal)} · seq ${pctOf(m.precision.sequential)}`}
                        />
                        <MetricTile label="Recall" value={pctOf(m.recall)} sub={`${fracOf(m.recall)} accesses predicted`} />
                        <MetricTile
                            label="Cache hits: predicted"
                            value={pctOf(m.hitRate.predicted)}
                            sub={`${fracOf(m.hitRate.predicted)} · unpredicted ${pctOf(m.hitRate.unpredicted)} (${fracOf(m.hitRate.unpredicted)})`}
                        />
                        <MetricTile
                            label="TTFB p50 hit / miss"
                            value={`${msOf(m.ttfbMs.hit.p50)} / ${msOf(m.ttfbMs.miss.p50)}`}
                            sub={`p95 ${msOf(m.ttfbMs.hit.p95)} / ${msOf(m.ttfbMs.miss.p95)} · n=${m.ttfbMs.hit.count}/${m.ttfbMs.miss.count}`}
                        />
                    </div>

                    <div className="px-6 py-3 border-b border-white/5 text-[10px] font-mono text-gray-500 flex flex-wrap gap-x-6 gap-y-1">
                        <span>cache {formatFileSize(data.cache.bytes)} / {formatFileSize(data.cache.maxBytes)} ({data.cache.entries})</span>
                        <span>prefetch {formatFileSize(data.cache.prefetchBytes)} / {formatFileSize(data.cache.prefetchMaxBytes)}</span>
                        <span>
                            warmed {sumOf(data.prefetch.warmed)} ({formatFileSize(data.prefetch.warmedBytes)}) · hit {sumOf(data.cache.prefetchHits)} · wasted {sumOf(data.cache.prefetchWasted)} · failed {data.prefetch.warmFailed}
                        </span>
                        <span>queue {data.prefetch.queue} · active {data.prefetch.active}/{data.config.concurrency}</span>
                        <span>model {data.model.trackedFiles} files · {data.model.trackedActors} actors · {data.model.observedEvents} events</span>
                        <span>events stored {data.events.written} · pending {data.events.pending} · dropped {data.events.dropped} · retention {data.events.retentionDays}d</span>
                        <span>disk-streamed TTFB p50 {msOf(m.ttfbMs.disk.p50)}</span>
                        {data.prefetch.lastTickAt && <span>last tick {new Date(data.prefetch.lastTickAt).toLocaleTimeString()}</span>}
                    </div>
                    {(data.model.rebuildError || data.events.lastError || data.prefetch.lastWarmError) && (
                        <div className="px-6 py-2 border-b border-white/5 text-[10px] font-mono text-red-400/80 truncate">
                            {data.model.rebuildError || data.events.lastError || data.prefetch.lastWarmError}
                        </div>
                    )}

                    <div className="overflow-x-auto">
                        <table className="w-full text-left text-sm whitespace-nowrap">
                            <thead className="uppercase tracking-wider border-b border-white/5 bg-white/5 font-bold text-[10px] text-gray-400">
                                <tr>
                                    <th scope="col" className="px-6 py-3">Predicted file (next window)</th>
                                    <th scope="col" className="px-6 py-3">P(access)</th>
                                    <th scope="col" className="px-6 py-3">λ temporal</th>
                                    <th scope="col" className="px-6 py-3">λ recency</th>
                                    <th scope="col" className="px-6 py-3">Prefetch</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-white/5 text-gray-300 font-mono text-[10px]">
                                {data.topPredictions.map((p) => (
                                    <tr key={p.shareId} className="hover:bg-white/5 transition-colors">
                                        <td className="px-6 py-3 max-w-[260px] truncate" title={p.shareId}>{p.name || p.shareId}</td>
                                        <td className="px-6 py-3 text-primary font-bold">{(p.score * 100).toFixed(1)}%</td>
                                        <td className="px-6 py-3">{p.lambdaTemporal.toFixed(3)}</td>
                                        <td className="px-6 py-3">{p.lambdaRecency.toFixed(3)}</td>
                                        <td className="px-6 py-3">
                                            <span className={`px-1.5 py-0.5 rounded text-[8px] uppercase font-bold border ${p.cached ? 'border-green-500/30 text-green-400 bg-green-500/10' : p.selected ? 'border-yellow-500/30 text-yellow-400 bg-yellow-500/10' : 'border-white/10 text-gray-400'}`}>
                                                {p.cached ? 'warm' : p.selected ? 'queued' : 'not cached'}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                        {data.topPredictions.length === 0 && (
                            <div className="p-12 text-center text-gray-600 text-xs uppercase tracking-widest font-mono">
                                No predictions above threshold yet — awaiting access history
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
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
                                Upload Hash Log
                            </h3>
                            <span className="text-[10px] font-mono text-primary opacity-50">HASH_CHAIN</span>
                        </div>
                        <div className="overflow-x-auto max-h-[400px]">
                            <table className="w-full text-left text-sm whitespace-nowrap">
                                <thead className="uppercase tracking-wider border-b border-white/5 bg-white/5 font-bold text-[10px] text-gray-400">
                                    <tr>
                                        <th scope="col" className="px-6 py-3">Block</th>
                                        <th scope="col" className="px-6 py-3">Digest</th>
                                        <th scope="col" className="px-6 py-3">File Hash</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/5 text-gray-300 font-mono text-[10px]">
                                    {(stats as any).ledgerBlocks?.map((block: any) => (
                                        <tr key={block.index} className="hover:bg-primary/5 transition-colors border-l-2 border-l-transparent hover:border-l-primary">
                                            <td className="px-6 py-4 text-primary font-bold">#{block.index}</td>
                                            <td className="px-6 py-4 opacity-70 italic truncate max-w-[150px]">{block.digest}</td>
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

                <EvolutionPanel />

                <StorePanel />

                <PredictionPanel />

            </main>
            <Footer />
        </div>
    );
}
