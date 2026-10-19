import { config } from '@/config';

/**
 * Plan definitions: the ONE place limits come from. Every limit is configurable through the environment (read on
 * each call, so tests and operators can change them without a rebuild of this module):
 *
 *   PLAN_<TIER>_MAX_FILE_MB        largest single upload                    (anon 100, free 200*, pro 5120)
 *   PLAN_<TIER>_STORAGE_GB         total size of the user's live files      (free 2, pro 500; anon: n/a)
 *   PLAN_<TIER>_EGRESS_GB          bytes served per calendar month (UTC)    (anon 2 per file, free 10, pro 1000)
 *   PLAN_<TIER>_MAX_EXPIRY_HOURS   longest share-link lifetime              (anon 24, free 168, pro 720)
 *   PLAN_<TIER>_PASSWORD_LINKS     password-protected links allowed          (true for every tier)
 *   PLAN_<TIER>_MONTHLY_UPLOADS    uploads per calendar month               (unlimited)
 *
 * <TIER> is ANON, FREE or PRO. Decimals are allowed ("0.5"); "unlimited" (or -1) removes a limit.
 * (*) Free's file size falls back to the legacy MAX_UPLOAD_BYTES when PLAN_FREE_MAX_FILE_MB is unset.
 * Every file-size limit is additionally capped by MAX_FILE_SIZE (config.storage.maxFileSize, the server's hard
 * ceiling, default 1 GB): raise it to let Pro users upload more than 1 GB.
 *
 * Anonymous uploads (ALLOW_ANONYMOUS_UPLOADS) have no account, so their egress quota applies per file per month
 * and there is no storage quota (anonymous files expire quickly instead).
 */

export type PlanId = 'anonymous' | 'free' | 'pro';

export interface PlanLimits {
    id: PlanId;
    name: string;
    /** Effective per-file limit in bytes (already capped by the server ceiling). */
    maxFileBytes: number;
    /** null = unlimited. Not applicable (null) for anonymous uploads. */
    storageQuotaBytes: number | null;
    /** Monthly egress quota in bytes; null = unlimited. Anonymous: per file. */
    monthlyEgressBytes: number | null;
    maxExpiryHours: number;
    defaultExpiryHours: number;
    passwordLinks: boolean;
    /** null = unlimited. */
    monthlyUploads: number | null;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

type Tier = 'ANON' | 'FREE' | 'PRO';

/** Parses a numeric env value; "unlimited"/-1 -> null; unset/invalid -> fallback. */
function limitEnv(name: string, fallback: number | null): number | null {
    const raw = process.env[name]?.trim();
    if (!raw) return fallback;
    if (/^(unlimited|none|-1)$/i.test(raw)) return null;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
    const raw = process.env[name]?.trim().toLowerCase();
    if (!raw) return fallback;
    return !['false', '0', 'no', 'off'].includes(raw);
}

const scaled = (v: number | null, unit: number) => (v === null ? null : Math.floor(v * unit));

/** Hard server ceiling for any single upload. */
export function serverMaxFileBytes(): number {
    return config.storage.maxFileSize;
}

function legacyFreeMaxFileMb(): number {
    const legacy = parseInt(process.env.MAX_UPLOAD_BYTES || '', 10);
    return Number.isFinite(legacy) && legacy > 0 ? legacy / MB : 200;
}

const DEFAULTS: Record<Tier, { maxFileMb: number; storageGb: number | null; egressGb: number | null; expiryH: number; password: boolean; uploads: number | null }> = {
    ANON: { maxFileMb: 100, storageGb: null, egressGb: 2, expiryH: 24, password: true, uploads: null },
    FREE: { maxFileMb: 200, storageGb: 2, egressGb: 10, expiryH: 168, password: true, uploads: null },
    PRO: { maxFileMb: 5120, storageGb: 500, egressGb: 1000, expiryH: 720, password: true, uploads: null },
};

const TIER_OF: Record<PlanId, Tier> = { anonymous: 'ANON', free: 'FREE', pro: 'PRO' };
const NAMES: Record<PlanId, string> = { anonymous: 'Anonymous', free: 'Free', pro: 'Pro' };

export function getPlan(id: PlanId): PlanLimits {
    const tier = TIER_OF[id];
    const d = DEFAULTS[tier];
    const fileFallback = tier === 'FREE' ? legacyFreeMaxFileMb() : d.maxFileMb;
    const maxFileMb = limitEnv(`PLAN_${tier}_MAX_FILE_MB`, fileFallback);
    const ceiling = serverMaxFileBytes();
    const maxFileBytes = maxFileMb === null ? ceiling : Math.min(Math.floor(maxFileMb * MB), ceiling);
    const maxExpiryHours = Math.max(1, limitEnv(`PLAN_${tier}_MAX_EXPIRY_HOURS`, d.expiryH) ?? 24 * 365);
    const uploads = limitEnv(`PLAN_${tier}_MONTHLY_UPLOADS`, d.uploads);
    return {
        id,
        name: NAMES[id],
        maxFileBytes,
        storageQuotaBytes: id === 'anonymous' ? null : scaled(limitEnv(`PLAN_${tier}_STORAGE_GB`, d.storageGb), GB),
        monthlyEgressBytes: scaled(limitEnv(`PLAN_${tier}_EGRESS_GB`, d.egressGb), GB),
        maxExpiryHours,
        defaultExpiryHours: Math.min(168, maxExpiryHours),
        passwordLinks: boolEnv(`PLAN_${tier}_PASSWORD_LINKS`, d.password),
        monthlyUploads: uploads === null ? null : Math.floor(uploads),
    };
}

export function allPlans(): PlanLimits[] {
    return (['anonymous', 'free', 'pro'] as PlanId[]).map(getPlan);
}

/** Largest upload any plan accepts (the tus Tus-Max-Size / protocol ceiling); per-plan checks run at creation. */
export function largestPlanFileBytes(): number {
    return Math.max(...allPlans().map((p) => p.maxFileBytes));
}

/** Credits charged per GiB of egress beyond the monthly quota (CREDITS_PER_GB, default 1). 0 disables overage. */
export function creditsPerGb(): number {
    const v = Number(process.env.CREDITS_PER_GB ?? '1');
    return Number.isFinite(v) && v >= 0 ? v : 1;
}

/** Days a past_due subscription keeps Pro (BILLING_GRACE_DAYS, default 7). */
export function graceDays(): number {
    const v = Number(process.env.BILLING_GRACE_DAYS ?? '7');
    return Number.isFinite(v) && v >= 0 ? v : 7;
}

/** Credits rounded UP to 6 decimals (what the NUMERIC(20,6) columns hold): overage is never undercharged. */
export function egressCost(bytes: number, perGb = creditsPerGb()): number {
    if (bytes <= 0 || perGb <= 0) return 0;
    return Math.ceil((bytes / GB) * perGb * 1e6) / 1e6;
}

/** Calendar month (UTC) used for monthly quotas: 'YYYY-MM'. */
export function usagePeriod(now = Date.now()): string {
    return new Date(now).toISOString().slice(0, 7);
}

/** Epoch ms when the current usage period ends (next month, UTC). */
export function periodResetAt(now = Date.now()): number {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

/** Clamps a requested link lifetime (hours) to the plan; null/invalid -> the plan default. */
export function resolveExpiryHours(plan: PlanLimits, requested: number | null | undefined): number {
    if (requested === null || requested === undefined || !Number.isFinite(requested) || requested <= 0) return plan.defaultExpiryHours;
    return Math.min(Math.max(requested, 1 / 60), plan.maxExpiryHours);
}

export const BYTES = { MB, GB };
