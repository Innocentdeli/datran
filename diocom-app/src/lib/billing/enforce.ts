import { randomUUID } from 'crypto';
import { createModuleLogger } from '../observability/logger';
import { recordEgress, recordQuotaRejection } from '../observability/metrics';
import { QuotaError, formatBytes } from './errors';
import { getPlan, creditsPerGb, egressCost, type PlanLimits } from './plans';
import { getUserPlan, getUserPlanId } from './entitlement';
import { debitCredits } from './credits';
import {
    addCreditedEgress,
    billableEgress,
    egressSubject,
    getMonthlyUsage,
    getStorageUsage,
    recordEgressBytes,
} from './usage';

const log = createModuleLogger('quota');

/**
 * Plan enforcement for uploads (creation time + while receiving) and downloads (/api/stream).
 * Who pays for egress: the FILE OWNER. Downloads beyond the owner's monthly egress quota are paid from the owner's
 * credit balance (CREDITS_PER_GB); without credits the downloader gets a friendly 402.
 */

function reject(e: QuotaError): never {
    recordQuotaRejection(e.limit, e.plan);
    throw e;
}

export interface UploadAllowance {
    plan: PlanLimits;
    /** Bytes of storage still free (null = unlimited / not applicable). */
    remainingStorage: number | null;
    /** Largest number of bytes this upload may contain (plan file limit and remaining storage). */
    maxBytes: number;
}

/**
 * Checks a new upload of `size` bytes (declared Upload-Length, or Content-Length for multipart) against the plan.
 * Throws QuotaError (413 max_file_size, 402 storage / monthly_uploads / password_links).
 */
export async function checkUploadQuota(input: { userId: string | null; size: number | null; hasPassword?: boolean }): Promise<UploadAllowance> {
    const plan = await getUserPlan(input.userId);
    const size = input.size ?? 0;
    if (size > plan.maxFileBytes) {
        reject(new QuotaError('max_file_size', `File exceeds the ${plan.name} plan limit of ${formatBytes(plan.maxFileBytes)} per file.`, plan.id, {
            limitBytes: plan.maxFileBytes, requestedBytes: size,
        }));
    }
    if (input.hasPassword && !plan.passwordLinks) {
        reject(new QuotaError('password_links', `Password-protected links are not included in the ${plan.name} plan.`, plan.id));
    }
    let remainingStorage: number | null = null;
    if (input.userId) {
        if (plan.storageQuotaBytes !== null) {
            const { storageBytes } = await getStorageUsage(input.userId);
            remainingStorage = Math.max(0, plan.storageQuotaBytes - storageBytes);
            if (size > remainingStorage) {
                reject(new QuotaError('storage',
                    `Storage quota exceeded: ${formatBytes(storageBytes)} of ${formatBytes(plan.storageQuotaBytes)} used; this file needs ${formatBytes(size)}. Delete files or wait for links to expire.`,
                    plan.id, { limitBytes: plan.storageQuotaBytes, usedBytes: storageBytes, requestedBytes: size }));
            }
        }
        if (plan.monthlyUploads !== null) {
            const { uploadsCount } = await getMonthlyUsage(input.userId);
            if (uploadsCount >= plan.monthlyUploads) {
                reject(new QuotaError('monthly_uploads', `Monthly upload limit reached (${plan.monthlyUploads} uploads on the ${plan.name} plan).`, plan.id));
            }
        }
    }
    return { plan, remainingStorage, maxBytes: Math.min(plan.maxFileBytes, remainingStorage ?? Number.MAX_SAFE_INTEGER) };
}

/** The QuotaError for an upload that turned out larger than `allowance.maxBytes` while streaming. */
export function oversizeError(allowance: UploadAllowance, receivedAtLeast: number): QuotaError {
    const { plan } = allowance;
    const e = allowance.maxBytes < plan.maxFileBytes && allowance.remainingStorage !== null
        ? new QuotaError('storage', `Storage quota exceeded: only ${formatBytes(allowance.remainingStorage)} of your ${formatBytes(plan.storageQuotaBytes)} storage is free.`, plan.id, {
            limitBytes: plan.storageQuotaBytes, requestedBytes: receivedAtLeast,
        })
        : new QuotaError('max_file_size', `File exceeds the ${plan.name} plan limit of ${formatBytes(plan.maxFileBytes)} per file.`, plan.id, {
            limitBytes: plan.maxFileBytes, requestedBytes: receivedAtLeast,
        });
    recordQuotaRejection(e.limit, e.plan);
    return e;
}

// ---- egress -------------------------------------------------------------------------------------------------------

export type EgressGrant = {
    ok: true;
    subject: string;
    plan: PlanLimits;
    /** Bytes added to the pending batch up front (corrected to the bytes actually sent when the body ends). */
    reserved: number;
    /** Credits debited from the owner for the part beyond the quota (0 when within quota). */
    charged: number;
};
export type EgressDecision = EgressGrant | { ok: false; error: QuotaError };

/**
 * Decides whether `bytes` may be served for a file owned by `ownerId` (null = anonymous upload), reserving them in
 * the pending egress batch. Over quota: debits the owner's credits for the overage (atomic, never negative), or
 * refuses with a 402 meant for the downloader.
 */
export async function authorizeEgress(input: { ownerId: string | null; shareId: string; bytes: number }): Promise<EgressDecision> {
    const subject = egressSubject(input.ownerId, input.shareId);
    const plan = getPlan(input.ownerId ? await getUserPlanId(input.ownerId) : 'anonymous');
    const bytes = Math.max(0, Math.floor(input.bytes));
    let charged = 0;
    const quota = plan.monthlyEgressBytes;
    if (quota !== null && bytes > 0) {
        const { billable } = await billableEgress(subject);
        const remaining = quota - billable;
        if (bytes > remaining) {
            const overage = bytes - Math.max(0, remaining);
            const cost = egressCost(overage);
            let paid = false;
            if (input.ownerId && cost > 0) {
                const r = await debitCredits(input.ownerId, cost, {
                    type: 'egress',
                    reason: `Downloads beyond the monthly allowance: ${formatBytes(overage)} (file ${input.shareId.slice(0, 8)}…)`,
                    idempotencyKey: `egress:${randomUUID()}`,
                    extra: (client) => addCreditedEgress(client, subject, overage),
                });
                paid = r.ok;
                if (r.ok) charged = cost;
            }
            if (!paid) {
                const e = input.ownerId
                    ? new QuotaError('monthly_egress',
                        "This file can't be downloaded right now: its owner has used this month's download allowance and has no credits left. Please let them know, or try again next month.",
                        plan.id, { limitBytes: quota, usedBytes: billable, requestedBytes: bytes })
                    : new QuotaError('monthly_egress',
                        "This file has reached its monthly download limit. Ask the sender to share it from an account.",
                        plan.id, { limitBytes: quota, usedBytes: billable, requestedBytes: bytes });
                recordQuotaRejection(e.limit, e.plan);
                if (input.ownerId && creditsPerGb() > 0) log.info({ ownerId: input.ownerId, bytes, overage }, 'egress refused: owner out of quota and credits');
                return { ok: false, error: e };
            }
        }
    }
    await recordEgressBytes(subject, bytes);
    return { ok: true, subject, plan, reserved: bytes, charged };
}

/** Corrects the reservation to the bytes actually sent (cancelled / short responses) and records metrics. */
export async function settleEgress(grant: EgressGrant, servedBytes: number): Promise<void> {
    recordEgress(grant.plan.id, servedBytes);
    const delta = servedBytes - grant.reserved;
    if (delta !== 0) await recordEgressBytes(grant.subject, delta);
}

/**
 * Wraps a response body so the bytes actually delivered are counted; `onDone(bytes)` runs exactly once when the
 * body ends, errors or is cancelled by the client.
 */
export function meterBody(body: ReadableStream<Uint8Array>, onDone: (bytes: number) => void): ReadableStream<Uint8Array> {
    const reader = body.getReader();
    let served = 0;
    let finished = false;
    const finish = () => {
        if (finished) return;
        finished = true;
        try { onDone(served); } catch { /* metering must not break the response */ }
    };
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    finish();
                    controller.close();
                    return;
                }
                served += value.byteLength;
                controller.enqueue(value);
            } catch (e) {
                finish();
                controller.error(e);
            }
        },
        async cancel(reason) {
            finish();
            await reader.cancel(reason).catch(() => undefined);
        },
    });
}
