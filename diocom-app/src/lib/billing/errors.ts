import { NextResponse } from 'next/server';
import type { PlanId } from './plans';

/**
 * Plan/quota rejections. Every upload or download refused by a plan limit answers with the same JSON shape:
 *
 *   { success: false, code, limit, message, plan, limitBytes?, usedBytes?, upgradeUrl, upgrade }
 *
 * 413 for "this single file is too big for your plan", 402 (Payment Required) for exhausted quotas.
 */

export type QuotaLimit = 'max_file_size' | 'storage' | 'monthly_egress' | 'monthly_uploads' | 'password_links' | 'credits';

const CODES: Record<QuotaLimit, string> = {
    max_file_size: 'FILE_TOO_LARGE',
    storage: 'STORAGE_QUOTA_EXCEEDED',
    monthly_egress: 'EGRESS_QUOTA_EXCEEDED',
    monthly_uploads: 'UPLOAD_QUOTA_EXCEEDED',
    password_links: 'PLAN_FEATURE_UNAVAILABLE',
    credits: 'INSUFFICIENT_CREDITS',
};

export const UPGRADE_URL = '/billing';

export class QuotaError extends Error {
    readonly code: string;
    readonly status: 402 | 413;
    constructor(
        readonly limit: QuotaLimit,
        message: string,
        readonly plan: PlanId,
        readonly detail: { limitBytes?: number | null; usedBytes?: number; requestedBytes?: number } = {},
    ) {
        super(message);
        this.name = 'QuotaError';
        this.code = CODES[limit];
        this.status = limit === 'max_file_size' ? 413 : 402;
    }

    get upgradeHint(): string {
        if (this.plan === 'anonymous') return 'Sign in for a free account with higher limits, or upgrade to Pro.';
        if (this.plan === 'free') {
            return this.limit === 'monthly_egress'
                ? 'Upgrade to Pro or buy credits to keep sharing beyond the monthly allowance.'
                : 'Upgrade to Pro for higher limits.';
        }
        return this.limit === 'monthly_egress' ? 'Buy credits to pay for downloads beyond the monthly allowance.' : 'Contact support to raise your limits.';
    }

    toJSON() {
        return {
            success: false,
            code: this.code,
            limit: this.limit,
            message: this.message,
            plan: this.plan,
            ...(this.detail.limitBytes !== undefined ? { limitBytes: this.detail.limitBytes } : {}),
            ...(this.detail.usedBytes !== undefined ? { usedBytes: this.detail.usedBytes } : {}),
            ...(this.detail.requestedBytes !== undefined ? { requestedBytes: this.detail.requestedBytes } : {}),
            upgradeUrl: UPGRADE_URL,
            upgrade: this.upgradeHint,
        };
    }
}

export function quotaErrorResponse(e: QuotaError, headers?: Record<string, string>): NextResponse {
    return NextResponse.json(e.toJSON(), { status: e.status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

export function formatBytes(n: number | null | undefined): string {
    if (n === null || n === undefined) return 'unlimited';
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v >= 10 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}
