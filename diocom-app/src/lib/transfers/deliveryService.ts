import db from '@/db';
import { randomBytes, createHash, randomUUID } from 'crypto';
import { sendEmail } from '@/lib/email/service';
import { AuditLogger } from '@/lib/AuditLogger';

export interface FileRecipient {
  id: string;
  file_id: string;
  email: string;
  token: string;
  status: 'sent' | 'opened' | 'downloaded';
  sent_at: number;
  opened_at: number | null;
  downloaded_at: number | null;
  otp_code_hash: string | null;
  otp_expires_at: number | null;
  otp_verified_at: number | null;
}

export function hashOtp(code: string): string {
  return createHash('sha256').update(code.trim()).digest('hex');
}

export const DeliveryService = {
  /** Send a transfer to a list of recipient emails with tracking */
  async sendTransferByEmail(params: {
    fileId: string;
    recipients: string[];
    senderEmail?: string;
    senderName?: string;
    customMessage?: string;
    requireOtp?: boolean;
    origin: string;
    keyFragment?: string;
  }): Promise<{ success: boolean; sentCount: number }> {
    const fileRes = await db.query('SELECT * FROM files WHERE share_id = $1', [params.fileId]);
    const file = fileRes.rows[0];
    if (!file) throw new Error('File not found');

    const requireOtp = params.requireOtp ? 1 : 0;
    const senderEmail = params.senderEmail?.trim() || null;
    const customMessage = params.customMessage?.trim() || null;

    // Update file settings
    await db.query(`
      UPDATE files 
      SET require_email_otp = $1, sender_email = $2, custom_message = $3 
      WHERE share_id = $4
    `, [requireOtp, senderEmail, customMessage, params.fileId]);

    const now = Date.now();
    let sentCount = 0;

    for (const rawEmail of params.recipients) {
      const email = rawEmail.trim().toLowerCase();
      if (!email || !email.includes('@')) continue;

      const token = randomBytes(24).toString('hex');
      const recipientId = randomUUID();

      await db.query(`
        INSERT INTO file_recipients (
          id, file_id, email, token, status, sent_at,
          opened_at, downloaded_at, otp_code_hash, otp_expires_at, otp_verified_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [
        recipientId,
        params.fileId,
        email,
        token,
        'sent',
        now,
        null,
        null,
        null,
        null,
        null
      ]);

      const downloadUrl = `${params.origin}/v1/${params.fileId}?t=${token}${params.keyFragment ? '#' + params.keyFragment : ''}`;
      const senderDisplayName = params.senderName || senderEmail || 'Someone';

      await sendEmail({
        to: email,
        subject: `[Datran] ${senderDisplayName} shared "${file.original_name}" with you`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; color: #111;">
            <div style="background: #0f172a; padding: 24px; border-radius: 12px; color: #fff; margin-bottom: 24px;">
              <h2 style="margin: 0 0 10px 0; font-size: 20px; color: #38bdf8;">File Shared With You</h2>
              <p style="margin: 0; font-size: 14px; color: #cbd5e1;">
                <strong>${senderDisplayName}</strong> sent you <strong>"${file.original_name}"</strong> via Datran.
              </p>
            </div>
            ${customMessage ? `
              <div style="margin: 16px 0; padding: 14px; background: #f8fafc; border-left: 4px solid #38bdf8; border-radius: 4px; font-size: 14px; color: #334155;">
                "${customMessage}"
              </div>
            ` : ''}
            <div style="margin: 28px 0;">
              <a href="${downloadUrl}" style="display: inline-block; background: #0284c7; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; font-size: 15px;">
                Download File
              </a>
            </div>
            <p style="font-size: 12px; color: #64748b; line-height: 1.5;">
              ${requireOtp ? '🔒 <strong>Security Notice:</strong> This transfer is protected with recipient verification. You will be asked to confirm your email before downloading.<br />' : ''}
              This file transfer is end-to-end encrypted with zero-knowledge security.
            </p>
          </div>
        `
      }).catch(err => console.error('[DELIVERY] Recipient email send error:', err));

      sentCount++;
    }

    return { success: true, sentCount };
  },

  /** Track when a recipient opens or downloads a file */
  async trackEvent(fileId: string, token: string, event: 'open' | 'download'): Promise<boolean> {
    const recRes = await db.query('SELECT * FROM file_recipients WHERE file_id = $1 AND token = $2', [fileId, token]);
    const recipient = recRes.rows[0];
    if (!recipient) return false;

    const fileRes = await db.query('SELECT * FROM files WHERE share_id = $1', [fileId]);
    const file = fileRes.rows[0];
    const now = Date.now();

    if (event === 'open') {
      if (!recipient.opened_at) {
        await db.query(`
          UPDATE file_recipients SET opened_at = $1, status = 'opened' WHERE id = $2 AND opened_at IS NULL
        `, [now, recipient.id]);

        if (file?.sender_email) {
          await sendEmail({
            to: file.sender_email,
            subject: `[Datran] ${recipient.email} opened your transfer`,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px;">
                <p><strong>${recipient.email}</strong> just opened your file <strong>"${file.original_name}"</strong> at ${new Date(now).toLocaleTimeString()}.</p>
              </div>
            `
          }).catch(() => undefined);
        }
      }
    } else if (event === 'download') {
      if (!recipient.downloaded_at) {
        await db.query(`
          UPDATE file_recipients SET downloaded_at = $1, status = 'downloaded' WHERE id = $2 AND downloaded_at IS NULL
        `, [now, recipient.id]);

        if (file?.sender_email) {
          await sendEmail({
            to: file.sender_email,
            subject: `[Datran] ${recipient.email} downloaded "${file.original_name}"`,
            html: `
              <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px;">
                <p><strong>${recipient.email}</strong> has downloaded your file <strong>"${file.original_name}"</strong> at ${new Date(now).toLocaleTimeString()}.</p>
              </div>
            `
          }).catch(() => undefined);
        }
      }
    }

    return true;
  },

  /** Send a 6-digit verification code to recipient's email */
  async sendOtp(fileId: string, email: string): Promise<boolean> {
    const normalizedEmail = email.trim().toLowerCase();
    const recRes = await db.query('SELECT * FROM file_recipients WHERE file_id = $1 AND email = $2', [fileId, normalizedEmail]);
    const recipient = recRes.rows[0];
    if (!recipient) throw new Error('Email address is not listed as an authorized recipient for this transfer');

    const fileRes = await db.query('SELECT original_name FROM files WHERE share_id = $1', [fileId]);
    const fileName = fileRes.rows[0]?.original_name || 'Protected File';

    // Generate random 6-digit numeric code
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const codeHash = hashOtp(otpCode);
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins

    await db.query(`
      UPDATE file_recipients SET otp_code_hash = $1, otp_expires_at = $2 WHERE id = $3
    `, [codeHash, expiresAt, recipient.id]);

    await sendEmail({
      to: normalizedEmail,
      subject: `[Datran] Your 6-digit access code: ${otpCode}`,
      html: `
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #111;">
          <h2 style="font-size: 20px; color: #0f172a; margin-bottom: 8px;">Your One-Time Passcode</h2>
          <p style="font-size: 14px; color: #475569; margin-bottom: 20px;">
            Use this code to verify your email and download <strong>"${fileName}"</strong>:
          </p>
          <div style="background: #f1f5f9; padding: 18px; border-radius: 10px; font-size: 28px; font-weight: bold; font-family: monospace; letter-spacing: 6px; text-align: center; color: #0284c7; margin-bottom: 20px;">
            ${otpCode}
          </div>
          <p style="font-size: 12px; color: #94a3b8;">
            This code expires in 15 minutes. If you did not expect this transfer, you can safely ignore this email.
          </p>
        </div>
      `
    });

    return true;
  },

  /** Verify recipient's 6-digit OTP code */
  async verifyOtp(fileId: string, email: string, code: string): Promise<{ verified: boolean; token: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const recRes = await db.query('SELECT * FROM file_recipients WHERE file_id = $1 AND email = $2', [fileId, normalizedEmail]);
    const recipient = recRes.rows[0];
    if (!recipient) throw new Error('Authorized recipient not found');

    if (!recipient.otp_code_hash || !recipient.otp_expires_at) {
      throw new Error('No active verification code found. Please request a new code.');
    }

    if (Date.now() > Number(recipient.otp_expires_at)) {
      throw new Error('Verification code has expired. Please request a new one.');
    }

    const inputHash = hashOtp(code);
    if (inputHash !== recipient.otp_code_hash) {
      throw new Error('Invalid verification code. Please check and try again.');
    }

    const now = Date.now();
    await db.query('UPDATE file_recipients SET otp_verified_at = $1 WHERE id = $2', [now, recipient.id]);

    return { verified: true, token: recipient.token };
  },

  /** List delivery recipients and tracking status for a file owner */
  async listRecipients(fileId: string): Promise<FileRecipient[]> {
    const res = await db.query('SELECT * FROM file_recipients WHERE file_id = $1 ORDER BY sent_at ASC', [fileId]);
    return res.rows as FileRecipient[];
  }
};
