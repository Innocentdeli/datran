import db from '@/db';
import { randomUUID } from 'crypto';
import { AuditLogger } from '@/lib/AuditLogger';
import { getLogger } from '@/lib/observability';

export type AbuseReason = 'malware' | 'dmca' | 'illegal' | 'harassment' | 'spam' | 'other';
export type AbuseStatus = 'pending' | 'resolved' | 'dismissed';

export interface AbuseReport {
  id: string;
  share_id: string;
  reporter_email?: string | null;
  reason: AbuseReason;
  details?: string | null;
  status: AbuseStatus;
  ip_address?: string | null;
  created_at: number;
  resolved_at?: number | null;
}

export async function submitAbuseReport(params: {
  shareId: string;
  reason: AbuseReason;
  details?: string;
  reporterEmail?: string;
  ipAddress?: string;
}): Promise<AbuseReport> {
  const id = randomUUID();
  const now = Date.now();

  const report: AbuseReport = {
    id,
    share_id: params.shareId,
    reporter_email: params.reporterEmail ? params.reporterEmail.trim().slice(0, 255) : null,
    reason: params.reason,
    details: params.details ? params.details.trim().slice(0, 2000) : null,
    status: 'pending',
    ip_address: params.ipAddress ? params.ipAddress.slice(0, 64) : null,
    created_at: now,
  };

  await db.query(
    `INSERT INTO abuse_reports (id, share_id, reporter_email, reason, details, status, ip_address, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      report.id,
      report.share_id,
      report.reporter_email,
      report.reason,
      report.details,
      report.status,
      report.ip_address,
      report.created_at,
    ]
  );

  await AuditLogger.record({
    action: 'ABUSE_REPORT_SUBMITTED',
    resource: params.shareId,
    details: `Reason: ${params.reason}${params.reporterEmail ? ` by ${params.reporterEmail}` : ''}`,
    ipAddress: params.ipAddress || 'unknown',
  });

  return report;
}

export async function getAbuseReports(filter?: {
  status?: AbuseStatus;
  limit?: number;
}): Promise<AbuseReport[]> {
  const limit = Math.min(filter?.limit ?? 50, 200);

  if (filter?.status) {
    const res = await db.query(
      `SELECT * FROM abuse_reports WHERE status = $1 ORDER BY created_at DESC LIMIT $2`,
      [filter.status, limit]
    );
    return res.rows as AbuseReport[];
  }

  const res = await db.query(
    `SELECT * FROM abuse_reports ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return res.rows as AbuseReport[];
}

export async function resolveAbuseReport(params: {
  reportId: string;
  action: 'disable_file' | 'dismiss' | 'ban_user';
  adminId?: string;
  reason?: string;
}): Promise<{ success: boolean; message: string }> {
  const now = Date.now();
  const reportRes = await db.query(`SELECT * FROM abuse_reports WHERE id = $1`, [params.reportId]);
  const report = reportRes.rows[0] as AbuseReport | undefined;

  if (!report) {
    throw new Error('Report not found');
  }

  if (params.action === 'dismiss') {
    await db.query(`UPDATE abuse_reports SET status = $1, resolved_at = $2 WHERE id = $3`, [
      'dismissed',
      now,
      params.reportId,
    ]);
    return { success: true, message: 'Report dismissed' };
  }

  if (params.action === 'disable_file' || params.action === 'ban_user') {
    const defaultReason = params.reason || `Violation of Datran Acceptable Use Policy (${report.reason})`;
    
    // Disable file
    await db.query(
      `UPDATE files SET is_disabled = 1, disabled_reason = $1 WHERE share_id = $2`,
      [defaultReason, report.share_id]
    );

    // If ban user requested, find file's owner
    if (params.action === 'ban_user') {
      const fileRes = await db.query(`SELECT user_id FROM files WHERE share_id = $1`, [report.share_id]);
      const ownerId = fileRes.rows[0]?.user_id as string | undefined;
      if (ownerId) {
        await db.query(
          `UPDATE users SET is_banned = 1, ban_reason = $1 WHERE id = $2`,
          [defaultReason, ownerId]
        );
      }
    }

    await db.query(`UPDATE abuse_reports SET status = $1, resolved_at = $2 WHERE id = $3`, [
      'resolved',
      now,
      params.reportId,
    ]);

    await AuditLogger.record({
      action: params.action === 'ban_user' ? 'USER_BANNED_MODERATION' : 'FILE_DISABLED_MODERATION',
      resource: report.share_id,
      details: `Action: ${params.action}, Reason: ${defaultReason}`,
      userId: params.adminId,
    });

    return {
      success: true,
      message: params.action === 'ban_user' ? 'File disabled and owner banned' : 'File disabled successfully',
    };
  }

  return { success: false, message: 'Unknown action' };
}
