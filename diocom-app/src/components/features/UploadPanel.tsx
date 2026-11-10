'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSession } from 'next-auth/react';
import { AlertCircle, CheckCircle2, Eye, EyeOff, Loader2, Lock, Pause, Play, RotateCcw, ShieldCheck, X, Clock, UploadCloud, Radio, QrCode, Users } from 'lucide-react';
import FileUploadZone from '@/components/features/FileUploadZone';
import ShareLinkPanel from '@/components/features/ShareLinkPanel';
import FileTypeIcon from '@/components/ui/FileTypeIcon';
import Button, { buttonClasses } from '@/components/ui/Button';
import { cn, formatDurationShort, formatFileSize, formatHours, formatSpeed } from '@/lib/utils';
import { detectFileType } from '@/lib/fileUtils';
import { addToHistory } from '@/lib/history';
import * as Encryption from '@/lib/crypto/Encryption';
import { discardResumableUpload, isAbortError, uploadEncryptedResumable } from '@/lib/upload/resumableClient';
import { CognitiveLens } from '@/lib/CognitiveLens';

/** The plan fields the upload UI needs (subset of PlanLimits, serialisable from the server page). */
export interface UploadPlanLimits {
  id: 'anonymous' | 'free' | 'pro';
  name: string;
  maxFileBytes: number;
  maxExpiryHours: number;
  defaultExpiryHours: number;
  passwordLinks: boolean;
}

type Phase = 'select' | 'uploading' | 'done';
type FileStatus = 'pending' | 'uploading' | 'done' | 'error';

interface FileRow {
  id: string;
  file: File;
  status: FileStatus;
  progress: number; // 0..1
  link?: string;
  error?: string;
  resumed?: boolean;
}

interface UploadFailure {
  status: number | null;
  message: string;
  upgrade?: string;
  upgradeUrl?: string;
}

class UploadError extends Error {
  constructor(readonly info: UploadFailure) {
    super(info.message);
  }
}

const EXPIRY_CHOICES = [1, 24, 72, 168, 336, 720];
const SPEED_WINDOW_MS = 5000;

function expiryOptions(plan: UploadPlanLimits): number[] {
  const opts = EXPIRY_CHOICES.filter((h) => h <= plan.maxExpiryHours);
  if (!opts.includes(plan.maxExpiryHours)) opts.push(plan.maxExpiryHours);
  return opts;
}

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

/** Only transport failures (no HTTP status) and server errors are worth retrying; 4xx (402 quota, 413...) are final. */
const isRetryable = (status: number | null) => status === null || status >= 500;

export default function UploadPanel({ plans }: { plans: Record<UploadPlanLimits['id'], UploadPlanLimits> }) {
  const { status: authStatus } = useSession();
  const isAuthenticated = authStatus === 'authenticated';
  const [accountPlan, setAccountPlan] = useState<UploadPlanLimits | null>(null);
  const plan = isAuthenticated ? accountPlan ?? plans.free : plans.anonymous;

  const [phase, setPhase] = useState<Phase>('select');
  const [rows, setRows] = useState<FileRow[]>([]);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [expiryChoice, setExpiryChoice] = useState<number | null>(null);
  const [failure, setFailure] = useState<UploadFailure | null>(null);
  const [rate, setRate] = useState<{ speed: number; eta: number } | null>(null);
  const [announce, setAnnounce] = useState('');
  const [paused, setPaused] = useState(false);

  const samples = useRef<Array<{ t: number; bytes: number }>>([]);
  const lastRateUpdate = useRef(0);
  const lastAnnounced = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /** Aborts the running batch; `stopReason` tells the loop whether that was Pause or Cancel. */
  const abortRef = useRef<AbortController | null>(null);
  const stopReason = useRef<'pause' | 'cancel' | null>(null);
  /** Link key of the current batch, kept across Pause/Resume so resumed files keep their key. */
  const batchKeyRef = useRef<string | null>(null);
  const passwordId = useId();
  const expiryId = useId();

  // Signed-in users: the plan comes from the billing summary (Free until it loads).
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    fetch('/api/billing/usage')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d?.plan) setAccountPlan(d.plan as UploadPlanLimits); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const options = useMemo(() => expiryOptions(plan), [plan]);
  const expiryHours = expiryChoice !== null && options.includes(expiryChoice)
    ? expiryChoice
    : options.includes(plan.defaultExpiryHours) ? plan.defaultExpiryHours : options[options.length - 1];

  const totalBytes = rows.reduce((a, r) => a + r.file.size, 0);
  const sentBytes = rows.reduce((a, r) => a + r.file.size * (r.status === 'done' ? 1 : r.progress), 0);
  const overallPct = totalBytes ? Math.min(100, Math.floor((sentBytes / totalBytes) * 100)) : 0;
  const tooLarge = rows.filter((r) => r.file.size > plan.maxFileBytes);
  const doneRows = rows.filter((r) => r.status === 'done' && r.link);
  const failedRows = rows.filter((r) => r.status === 'error');

  // Warn before leaving mid-upload (the transfer pauses; re-selecting the same file resumes it).
  useEffect(() => {
    if (phase !== 'uploading') return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [phase]);

  const addFiles = useCallback((files: File[]) => {
    setFailure(null);
    setRows((prev) => {
      const seen = new Set(prev.map((r) => r.id));
      const added = files
        .filter((f) => !seen.has(fileKey(f)))
        .map((file) => ({ id: fileKey(file), file, status: 'pending' as FileStatus, progress: 0 }));
      return [...prev, ...added];
    });
  }, []);

  const removeFile = (id: string) => setRows((prev) => prev.filter((r) => r.id !== id));

  const updateRow = (id: string, patch: Partial<FileRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const reset = () => {
    batchKeyRef.current = null;
    setPaused(false);
    setRows([]);
    setPassword('');
    setFailure(null);
    setRate(null);
    setAnnounce('');
    setPhase('select');
  };

  /** Speed over a sliding window of measured (time, bytes) samples; ETA from the remaining bytes. */
  const recordProgress = (bytesDone: number, total: number) => {
    const now = performance.now();
    const s = samples.current;
    s.push({ t: now, bytes: bytesDone });
    while (s.length > 2 && now - s[0].t > SPEED_WINDOW_MS) s.shift();
    if (now - lastRateUpdate.current < 400) return;
    lastRateUpdate.current = now;
    const first = s[0];
    const dt = (now - first.t) / 1000;
    if (dt >= 1 && bytesDone > first.bytes) {
      const speed = (bytesDone - first.bytes) / dt;
      setRate({ speed, eta: Math.max(0, (total - bytesDone) / speed) });
    }
    const pct = total ? Math.floor((bytesDone / total) * 100) : 0;
    if (pct - lastAnnounced.current >= 25) {
      lastAnnounced.current = pct - (pct % 25);
      setAnnounce(`Upload ${lastAnnounced.current}% complete`);
    }
  };

  const handleUploadStart = async () => {
    const batch = rows.filter((r) => r.status !== 'done');
    if ((phase === 'uploading' && !paused) || batch.length === 0) return;
    const resuming = paused;

    const ac = new AbortController();
    abortRef.current = ac;
    stopReason.current = null;
    setPaused(false);
    setPhase('uploading');
    setFailure(null);
    setRate(null);
    samples.current = [];
    lastAnnounced.current = 0;
    setAnnounce(resuming ? 'Upload resumed' : `Uploading ${batch.length} file${batch.length > 1 ? 's' : ''}`);
    // A resumed batch keeps the progress shown so far (the transfer continues from the server's offset).
    setRows((prev) => prev.map((r) => (r.status === 'done' ? r : { ...r, status: 'pending', progress: resuming ? r.progress : 0, error: undefined })));

    const total = batch.reduce((a, r) => a + r.file.size, 0);
    let completedBytes = 0;
    let lastFailure: UploadFailure | null = null;

    // One encryption key per batch; it travels only in the link fragment (#key=...).
    if (!batchKeyRef.current) batchKeyRef.current = await Encryption.exportKey(await Encryption.generateKey());
    const batchKeyStr = batchKeyRef.current;

    for (const row of batch) {
      if (ac.signal.aborted) break;
      const file = row.file;
      updateRow(row.id, { status: 'uploading', ...(resuming ? {} : { progress: 0 }) });

      let attempts = 0;
      const maxAttempts = 3;
      let success = false;

      while (attempts < maxAttempts && !success && !ac.signal.aborted) {
        attempts++;
        try {
          const aiMeta = await CognitiveLens.analyze(file);

          // The file is encrypted chunk by chunk (DCE2) while it is read, so memory stays bounded for multi-GB files.
          // Resumable (tus, /api/uploads): network drops are retried and resumed automatically, and selecting the
          // same file again after a reload continues where it stopped; tiny files use a single /api/ingest request.
          const fields: Array<[string, string]> = [];
          if (password) fields.push(['password', password]);
          fields.push(['expires_in_hours', String(expiryHours)]);
          fields.push(['tags', JSON.stringify([...aiMeta.tags, 'Zero-Knowledge'])]);
          fields.push(['summary', aiMeta.summary + (aiMeta.sensitivity === 'High' ? ' [HIGH SENSITIVITY]' : '')]);
          fields.push(['category', aiMeta.category]);

          let lastFraction = 0;
          const result = await uploadEncryptedResumable({
            file,
            keyStr: batchKeyStr,
            fields,
            signal: ac.signal,
            onProgress: (fraction) => {
              const f = Math.max(0, Math.min(1, fraction));
              if (f - lastFraction < 0.005 && f < 1) return;
              lastFraction = f;
              updateRow(row.id, { progress: f });
              recordProgress(completedBytes + f * file.size, total);
            },
          });
          const data = result.data as { success?: boolean; message?: string; error?: string; link?: string; upgrade?: string; upgradeUrl?: string } | null;
          if (result.status < 200 || result.status >= 300) {
            throw new UploadError({
              status: result.status,
              message: data?.message || data?.error || `The server answered HTTP ${result.status}.`,
              upgrade: data?.upgrade,
              upgradeUrl: data?.upgradeUrl,
            });
          }
          if (!data?.success || !data.link) throw new UploadError({ status: result.status, message: data?.message || 'The server did not return a link.' });
          // A resumed upload keeps the link key it was started with.
          const fileKeyStr = result.keyStr;
          const uploadedShareId = data.link.split('/').pop() || file.name;
          try {
            localStorage.setItem(`diocom_key_${uploadedShareId}`, fileKeyStr);
          } catch { /* storage disabled */ }
          const link = `${data.link}#key=${fileKeyStr}`;
          addToHistory({ id: uploadedShareId, shareId: uploadedShareId, filename: file.name, size: file.size, type: detectFileType(file.name) });
          window.dispatchEvent(new Event('diocom-history-update'));
          updateRow(row.id, { status: 'done', progress: 1, link, resumed: !!result.resumedFrom });
          success = true;
        } catch (e) {
          if (ac.signal.aborted || isAbortError(e)) break; // paused or cancelled
          const info: UploadFailure = e instanceof UploadError ? e.info : { status: null, message: e instanceof Error ? e.message : String(e) };
          if (attempts === maxAttempts || !isRetryable(info.status)) {
            lastFailure = info;
            updateRow(row.id, { status: 'error', error: info.message });
            break;
          }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      if (ac.signal.aborted) break;
      completedBytes += file.size;
    }

    if (abortRef.current === ac) abortRef.current = null;
    if (ac.signal.aborted) {
      setRate(null);
      if (stopReason.current === 'pause') {
        setPaused(true);
        setAnnounce('Upload paused');
        return;
      }
      // Cancelled: forget the unfinished uploads (server + resume state) and go back to the selection.
      await Promise.all(batch.map((r) => discardResumableUpload(r.file).catch(() => undefined)));
      cancelled();
      return;
    }

    batchKeyRef.current = null;
    setRate(null);
    setFailure(lastFailure);
    setPhase('done');
    setAnnounce(lastFailure ? `Upload finished with errors: ${lastFailure.message}` : 'Upload complete. Your share link is ready.');
    requestAnimationFrame(() => headingRef.current?.focus());
  };

  const cancelled = () => {
    batchKeyRef.current = null;
    setPaused(false);
    setRows((prev) => prev.map((r) => (r.status === 'done' ? r : { ...r, status: 'pending', progress: 0, error: undefined })));
    setPhase('select');
    setAnnounce('Upload cancelled');
  };

  const stopUpload = (reason: 'pause' | 'cancel') => {
    stopReason.current = reason;
    if (abortRef.current) {
      abortRef.current.abort();
    } else if (reason === 'cancel' && paused) {
      // Cancel while paused: nothing is running, discard right away.
      void Promise.all(rows.filter((r) => r.status !== 'done').map((r) => discardResumableUpload(r.file).catch(() => undefined)));
      cancelled();
    }
  };

  const retryFailed = () => {
    setRows((prev) => prev.filter((r) => r.status !== 'done'));
    setFailure(null);
    setPhase('select');
  };

  const isQuota = failure?.status === 402 || failure?.status === 413;
  const needsSignIn = failure?.status === 401;

  return (
    <section aria-labelledby="upload-heading" className="panel relative w-full p-4 sm:p-6">
      <p className="sr-only" aria-live="polite" role="status">{announce}</p>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="upload-heading" ref={headingRef} tabIndex={-1} className="text-base font-semibold text-white focus:outline-none">
          {phase === 'done'
            ? doneRows.length
              ? doneRows.length > 1 ? `${doneRows.length} links ready` : 'Your link is ready'
              : 'Upload failed'
            : phase === 'uploading' ? (paused ? 'Paused' : 'Uploading…') : rows.length ? `${rows.length} file${rows.length > 1 ? 's' : ''} selected` : 'Send files'}
        </h2>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/20 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-300">
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> End-to-end encrypted
        </span>
      </div>

      {/* Industrial Transfer Mode Switcher */}
      {phase === 'select' && (
        <nav aria-label="Transfer Mode" className="mb-4 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          <div className="flex items-center justify-center gap-1.5 rounded-xl border border-primary/40 bg-primary/10 px-2.5 py-2 text-xs font-semibold text-primary shadow-sm">
            <UploadCloud className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Cloud Link</span>
          </div>
          <Link
            href="/radar"
            title="Radar: beam files to nearby devices on Wi-Fi"
            className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs font-medium text-gray-300 transition-colors hover:border-cyan-500/40 hover:bg-cyan-500/10 hover:text-cyan-300"
          >
            <Radio className="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
            <span>Radar Beam</span>
          </Link>
          <Link
            href="/pair"
            title="QR Pair: instant handoff between computer and phone"
            className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs font-medium text-gray-300 transition-colors hover:border-emerald-500/40 hover:bg-emerald-500/10 hover:text-emerald-300"
          >
            <QrCode className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />
            <span>QR Device Pair</span>
          </Link>
          <Link
            href="/lobby"
            title="Group Lobby: share with a room code"
            className="flex items-center justify-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.03] px-2.5 py-2 text-xs font-medium text-gray-300 transition-colors hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-300"
          >
            <Users className="h-3.5 w-3.5 text-amber-400" aria-hidden="true" />
            <span>Group Lobby</span>
          </Link>
        </nav>
      )}

      {/* ---------- Select / options ---------- */}
      {phase === 'select' && (
        <div className="flex flex-col gap-4">
          {rows.length === 0 ? (
            <FileUploadZone onFilesSelect={addFiles} maxFileBytes={plan.maxFileBytes} />
          ) : (
            <>
              <ul className="flex flex-col divide-y divide-white/5 rounded-2xl border border-white/10 bg-black/20" aria-label="Selected files">
                {rows.map((r) => {
                  const over = r.file.size > plan.maxFileBytes;
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                      <FileTypeIcon name={r.file.name} size="sm" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-white" title={r.file.name}>{r.file.name}</p>
                        <p className={cn('text-xs', over ? 'text-red-300' : 'text-gray-400')}>
                          {formatFileSize(r.file.size)}
                          {over ? ` · over the ${formatFileSize(plan.maxFileBytes)} limit of your plan` : ''}
                          {r.status === 'error' && r.error ? ` · failed: ${r.error}` : ''}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeFile(r.id)}
                        aria-label={`Remove ${r.file.name}`}
                        className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-gray-400 transition-colors hover:bg-white/5 hover:text-white"
                      >
                        <X className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <FileUploadZone onFilesSelect={addFiles} compact />

              <fieldset className="grid gap-4 sm:grid-cols-2">
                <legend className="sr-only">Link options</legend>
                <div>
                  <label htmlFor={expiryId} className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-200">
                    <Clock className="h-4 w-4 text-gray-400" aria-hidden="true" /> Link expires after
                  </label>
                  <select
                    id={expiryId}
                    value={expiryHours}
                    onChange={(e) => setExpiryChoice(Number(e.target.value))}
                    className="h-11 w-full rounded-xl border border-white/10 bg-black/40 px-3 text-sm text-white focus:border-primary/60 focus:outline-none"
                  >
                    {options.map((h) => (
                      <option key={h} value={h} className="bg-surface">{formatHours(h)}</option>
                    ))}
                  </select>
                  {plan.id !== 'pro' && (
                    <p className="mt-1.5 text-xs text-gray-400">
                      {plan.name} links last up to {formatHours(plan.maxExpiryHours)}.{' '}
                      {plan.id === 'anonymous'
                        ? <Link href="/auth/signin" className="text-primary underline-offset-2 hover:underline">Sign in for longer</Link>
                        : <Link href="/billing" className="text-primary underline-offset-2 hover:underline">Pro: up to {formatHours(plans.pro.maxExpiryHours)}</Link>}
                    </p>
                  )}
                </div>

                {plan.passwordLinks && (
                  <div>
                    <label htmlFor={passwordId} className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-gray-200">
                      <Lock className="h-4 w-4 text-gray-400" aria-hidden="true" /> Password <span className="font-normal text-gray-400">(optional)</span>
                    </label>
                    <div className="relative">
                      <input
                        id={passwordId}
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        autoComplete="new-password"
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="No password"
                        className="h-11 w-full rounded-xl border border-white/10 bg-black/40 pl-3 pr-11 text-sm text-white placeholder:text-gray-500 focus:border-primary/60 focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        aria-pressed={showPassword}
                        className="absolute right-1 top-1 grid h-9 w-9 place-items-center rounded-lg text-gray-400 hover:text-white"
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs text-gray-400">Recipients must enter it before they can open the file.</p>
                  </div>
                )}
              </fieldset>

              <div className="flex flex-col-reverse gap-3 border-t border-white/10 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-gray-400">
                  {rows.length} file{rows.length > 1 ? 's' : ''} · {formatFileSize(totalBytes)}
                </p>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={reset}>Clear</Button>
                  <Button onClick={handleUploadStart} disabled={tooLarge.length > 0} className="flex-1 sm:flex-none sm:min-w-44">
                    Upload &amp; get link
                  </Button>
                </div>
              </div>
              {tooLarge.length > 0 && (
                <p className="text-sm text-red-300" role="alert">
                  Remove {tooLarge.length === 1 ? 'the file' : `${tooLarge.length} files`} over {formatFileSize(plan.maxFileBytes)}, or{' '}
                  {plan.id === 'pro' ? 'contact support for higher limits.' : <Link href={plan.id === 'anonymous' ? '/auth/signin' : '/billing'} className="font-medium text-primary underline underline-offset-2">{plan.id === 'anonymous' ? 'sign in' : 'upgrade to Pro'}</Link>}
                  {plan.id === 'pro' ? '' : ' for larger files.'}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* ---------- Uploading ---------- */}
      {phase === 'uploading' && (
        <div className="flex flex-col gap-4">
          <div>
            <div className="mb-2 flex items-baseline justify-between gap-3">
              <span className="text-3xl font-semibold tabular-nums text-white">{overallPct}%</span>
              <span className="text-sm tabular-nums text-gray-300">
                {formatFileSize(Math.round(sentBytes))} of {formatFileSize(totalBytes)}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label="Upload progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={overallPct}
              className="h-2 w-full overflow-hidden rounded-full bg-white/10"
            >
              <div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${overallPct}%` }} />
            </div>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm tabular-nums text-gray-300">
              <span>Speed: {rate ? formatSpeed(rate.speed) : 'measuring…'}</span>
              <span>Time left: {rate ? formatDurationShort(rate.eta) : '—'}</span>
            </p>
          </div>

          <ul className="flex flex-col divide-y divide-white/5 rounded-2xl border border-white/10 bg-black/20" aria-label="Files">
            {rows.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                <FileTypeIcon name={r.file.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white" title={r.file.name}>{r.file.name}</p>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10" aria-hidden="true">
                    <div
                      className={cn('h-full rounded-full transition-[width] duration-300', r.status === 'error' ? 'bg-red-400' : r.status === 'done' ? 'bg-emerald-400' : 'bg-primary')}
                      style={{ width: `${Math.round((r.status === 'done' ? 1 : r.progress) * 100)}%` }}
                    />
                  </div>
                </div>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums text-gray-300">
                  {r.status === 'done' ? (
                    <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-400" aria-label="Done" />
                  ) : r.status === 'error' ? (
                    <AlertCircle className="ml-auto h-4 w-4 text-red-400" aria-label="Failed" />
                  ) : r.status === 'pending' && !(paused && r.progress > 0) ? (
                    'Waiting'
                  ) : (
                    `${Math.round(r.progress * 100)}%`
                  )}
                </span>
              </li>
            ))}
          </ul>

          {paused ? (
            <p className="flex items-start gap-2 text-xs text-gray-400">
              <Pause className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
              Paused. Resume continues from where the upload stopped.
            </p>
          ) : (
            <p className="flex items-start gap-2 text-xs text-gray-400">
              <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
              Encrypting in your browser and uploading. If your connection drops the upload retries automatically; if you
              close this tab, select the same file again later to resume.
            </p>
          )}

          <div className="flex justify-end gap-2 border-t border-white/10 pt-4">
            <Button variant="ghost" onClick={() => stopUpload('cancel')}>
              <X className="h-4 w-4" aria-hidden="true" /> Cancel
            </Button>
            {paused ? (
              <Button variant="secondary" onClick={handleUploadStart}>
                <Play className="h-4 w-4" aria-hidden="true" /> Resume
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => stopUpload('pause')}>
                <Pause className="h-4 w-4" aria-hidden="true" /> Pause
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ---------- Done / errors ---------- */}
      {phase === 'done' && (
        <div className="flex flex-col gap-4">
          {failure && (
            <div role="alert" className="flex gap-3 rounded-2xl border border-red-400/25 bg-red-500/10 p-4 text-sm">
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-300" aria-hidden="true" />
              <div className="flex flex-col gap-2">
                <p className="font-medium text-red-200">
                  {failedRows.length > 1 ? `${failedRows.length} files could not be uploaded.` : `${failedRows[0]?.file.name ?? 'The file'} could not be uploaded.`}
                </p>
                <p className="text-red-200/90">{failure.message}</p>
                {failure.upgrade ? <p className="text-gray-300">{failure.upgrade}</p> : null}
                <div className="mt-1 flex flex-wrap gap-2">
                  {isQuota && (
                    <Link href={failure.upgradeUrl || '/billing'} className={buttonClasses('primary', 'sm')}>
                      {plan.id === 'anonymous' ? 'See plans' : 'Upgrade to Pro'}
                    </Link>
                  )}
                  {(needsSignIn || (isQuota && plan.id === 'anonymous')) && (
                    <Link href="/auth/signin" className={buttonClasses('secondary', 'sm')}>Sign in</Link>
                  )}
                  <Button variant="secondary" size="sm" onClick={retryFailed}>
                    <RotateCcw className="h-4 w-4" aria-hidden="true" /> Try again
                  </Button>
                </div>
              </div>
            </div>
          )}

          {doneRows.length > 0 && (
            <>
              <ul className="flex flex-col gap-3" aria-label="Share links">
                {doneRows.map((r) => (
                  <li key={r.id}>
                    <ShareLinkPanel
                      url={r.link!}
                      fileName={r.file.name}
                      fileSize={r.file.size}
                      qrOpen={doneRows.length === 1}
                      showSendOptions={isAuthenticated}
                    />
                  </li>
                ))}
              </ul>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-400">
                <li className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5" aria-hidden="true" /> Expires in {formatHours(expiryHours)}</li>
                {password ? <li className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" aria-hidden="true" /> Password protected</li> : null}
                <li className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" /> The decryption key is the part after “#” and never reaches our server</li>
              </ul>
            </>
          )}

          <div className="flex justify-end border-t border-white/10 pt-4">
            <Button variant={doneRows.length ? 'secondary' : 'ghost'} onClick={reset}>Send more files</Button>
          </div>
        </div>
      )}
    </section>
  );
}
