import db from '@/db';
import { randomUUID } from 'crypto';
import { sendEmail } from '@/lib/email/service';
import { AuditLogger } from '@/lib/AuditLogger';
import { resolveOrigin } from '@/config';

export interface FileRequest {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  description: string | null;
  destination_space_id: string | null;
  max_file_size: number | null;
  expires_at: number | null;
  is_active: number;
  password_hash: string | null;
  recipient_public_key: string | null;
  upload_count: number;
  total_bytes: number;
  created_at: number;
  updated_at: number;
}

export interface FileRequestUpload {
  id: string;
  request_id: string;
  file_id: string;
  uploader_name: string | null;
  uploader_email: string | null;
  uploader_note: string | null;
  status: string;
  uploaded_at: number;
  original_name?: string;
  file_size?: number;
  mime_type?: string;
  is_encrypted?: number;
}

export function sanitizeSlug(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

export const FileRequestService = {
  /** Create a new file request */
  async createRequest(
    userId: string,
    params: {
      title: string;
      description?: string;
      slug?: string;
      destinationSpaceId?: string;
      maxFileSize?: number;
      expiresInHours?: number;
      passwordHash?: string;
      recipientPublicKey?: string;
    }
  ): Promise<FileRequest> {
    const id = randomUUID();
    const now = Date.now();
    
    // Generate clean slug
    let baseSlug = params.slug ? sanitizeSlug(params.slug) : sanitizeSlug(params.title);
    if (!baseSlug || baseSlug.length < 3) {
      baseSlug = `req-${randomUUID().slice(0, 8)}`;
    }
    
    // Check if slug is taken
    const existing = await db.query('SELECT id FROM file_requests WHERE slug = $1', [baseSlug]);
    const finalSlug = existing.rows.length > 0 ? `${baseSlug}-${randomUUID().slice(0, 4)}` : baseSlug;

    const expiresAt = params.expiresInHours ? now + params.expiresInHours * 3600 * 1000 : null;

    await db.query(`
      INSERT INTO file_requests (
        id, user_id, slug, title, description, destination_space_id,
        max_file_size, expires_at, is_active, password_hash, recipient_public_key,
        upload_count, total_bytes, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    `, [
      id,
      userId,
      finalSlug,
      params.title.trim(),
      params.description?.trim() || null,
      params.destinationSpaceId || null,
      params.maxFileSize || null,
      expiresAt,
      1,
      params.passwordHash || null,
      params.recipientPublicKey || null,
      0,
      0,
      now,
      now,
    ]);

    await AuditLogger.record({
      userId,
      action: 'FILE_REQUEST_CREATED',
      resource: id,
      details: `Created file request slug='${finalSlug}' title='${params.title}'`
    });

    const res = await db.query('SELECT * FROM file_requests WHERE id = $1 AND user_id = $2', [id, userId]);
    return res.rows[0] as FileRequest;
  },

  /** List all file requests created by a user */
  async listUserRequests(userId: string): Promise<FileRequest[]> {
    const res = await db.query('SELECT * FROM file_requests WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return res.rows as FileRequest[];
  },

  /** Get a single request with its received files for the owner */
  async getRequestDetails(id: string, userId: string): Promise<{ request: FileRequest; uploads: FileRequestUpload[] } | null> {
    const reqRes = await db.query('SELECT * FROM file_requests WHERE id = $1 AND user_id = $2', [id, userId]);
    const request = reqRes.rows[0] as FileRequest;
    if (!request) return null;

    const uploadsRes = await db.query(`
      SELECT fru.*, f.original_name, f.file_size, f.mime_type, f.is_encrypted 
      FROM file_request_uploads fru 
      JOIN files f ON f.share_id = fru.file_id 
      WHERE fru.request_id = $1 
      ORDER BY fru.uploaded_at DESC
    `, [id]);

    return {
      request,
      uploads: uploadsRes.rows as FileRequestUpload[],
    };
  },

  /** Public lookup for clients arriving at /r/[slug] */
  async getPublicRequest(slug: string): Promise<{
    id: string;
    slug: string;
    title: string;
    description: string | null;
    requester_name: string;
    max_file_size: number | null;
    is_active: number;
    has_password: boolean;
    expires_at: number | null;
    is_expired: boolean;
    brand?: {
      brand_name: string | null;
      brand_logo_url: string | null;
      brand_color: string | null;
      brand_wallpaper_url: string | null;
      brand_tagline: string | null;
    } | null;
  } | null> {
    const res = await db.query(`
      SELECT fr.*, u.name as requester_name, u.email as requester_email 
      FROM file_requests fr 
      JOIN users u ON u.id = fr.user_id 
      WHERE fr.slug = $1
    `, [slug]);

    const row = res.rows[0];
    if (!row) return null;

    const now = Date.now();
    const isExpired = row.expires_at ? now > Number(row.expires_at) : false;

    // Optional brand lookup
    let brand = null;
    try {
      const bRes = await db.query('SELECT * FROM user_brands WHERE user_id = $1', [row.user_id]);
      const bRow = bRes.rows[0];
      if (bRow) {
        brand = {
          brand_name: bRow.brand_name as string | null,
          brand_logo_url: bRow.brand_logo_url as string | null,
          brand_color: bRow.brand_color as string | null,
          brand_wallpaper_url: bRow.brand_wallpaper_url as string | null,
          brand_tagline: bRow.brand_tagline as string | null,
        };
      }
    } catch {
      // Brand is optional
    }

    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      requester_name: row.requester_name || 'Datran User',
      max_file_size: row.max_file_size ? Number(row.max_file_size) : null,
      is_active: row.is_active,
      has_password: !!row.password_hash,
      expires_at: row.expires_at ? Number(row.expires_at) : null,
      is_expired: isExpired,
      brand,
    };
  },

  /** Attach a client's newly ingested file to this file request */
  async attachUpload(
    slug: string,
    params: {
      fileId: string;
      fileSize: number;
      uploaderName?: string;
      uploaderEmail?: string;
      uploaderNote?: string;
    }
  ): Promise<{ success: boolean; uploadId: string }> {
    const reqRes = await db.query(`
      SELECT fr.*, u.name as requester_name, u.email as requester_email 
      FROM file_requests fr 
      JOIN users u ON u.id = fr.user_id 
      WHERE fr.slug = $1
    `, [slug]);

    const request = reqRes.rows[0];
    if (!request) throw new Error('File request not found');
    if (!request.is_active) throw new Error('This file request is currently closed or paused');
    if (request.expires_at && Date.now() > Number(request.expires_at)) {
      throw new Error('This file request link has expired');
    }

    const uploadId = randomUUID();
    const now = Date.now();

    await db.query(`
      INSERT INTO file_request_uploads (
        id, request_id, file_id, uploader_name, uploader_email, uploader_note, status, uploaded_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      uploadId,
      request.id,
      params.fileId,
      params.uploaderName?.trim() || null,
      params.uploaderEmail?.trim() || null,
      params.uploaderNote?.trim() || null,
      'received',
      now
    ]);

    // Update aggregate counters on the request
    await db.query(`
      UPDATE file_requests 
      SET upload_count = upload_count + 1, total_bytes = total_bytes + $1, updated_at = $2 
      WHERE id = $3
    `, [params.fileSize, now, request.id]);

    // If destination space is set, also link to that space
    if (request.destination_space_id) {
      await db.query(`
        INSERT INTO space_files (space_id, file_id, uploaded_by, uploaded_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (space_id, file_id) DO UPDATE SET uploaded_at = EXCLUDED.uploaded_at
      `, [request.destination_space_id, params.fileId, request.user_id, now]).catch(() => undefined);
    }

    // Send instant notification email to requester
    if (request.requester_email) {
      const uploaderDisplayName = params.uploaderName || params.uploaderEmail || 'A client';
      await sendEmail({
        to: request.requester_email,
        subject: `[Datran] New file received on "${request.title}"`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 580px; margin: 0 auto; padding: 24px; color: #111;">
            <div style="background: #0f172a; padding: 20px; border-radius: 12px; color: #fff; margin-bottom: 24px;">
              <h2 style="margin: 0 0 8px 0; font-size: 20px; color: #38bdf8;">New File Received</h2>
              <p style="margin: 0; font-size: 14px; color: #94a3b8;">${uploaderDisplayName} just uploaded a file to your request <strong>"${request.title}"</strong>.</p>
            </div>
            ${params.uploaderNote ? `<p style="padding: 12px; background: #f1f5f9; border-radius: 8px; font-style: italic;">"${params.uploaderNote}"</p>` : ''}
            <div style="margin: 24px 0;">
              <a href="${resolveOrigin()}/dashboard/requests" style="display: inline-block; background: #0284c7; color: #fff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
                View Files in Dashboard
              </a>
            </div>
            <p style="font-size: 12px; color: #64748b;">This transfer is end-to-end encrypted with zero-knowledge guarantees.</p>
          </div>
        `
      }).catch((err: unknown) => console.error('[FILE_REQUEST] Notification email error:', err));
    }

    return { success: true, uploadId };
  },

  /** Toggle active status (pause / resume) */
  async toggleActive(id: string, userId: string, isActive: boolean): Promise<boolean> {
    const res = await db.query(`
      UPDATE file_requests SET is_active = $1, updated_at = $2 WHERE id = $3 AND user_id = $4
    `, [isActive ? 1 : 0, Date.now(), id, userId]);
    return Boolean(res.rowCount && res.rowCount > 0);
  },

  /** Delete a file request */
  async deleteRequest(id: string, userId: string): Promise<boolean> {
    const res = await db.query('DELETE FROM file_requests WHERE id = $1 AND user_id = $2', [id, userId]);
    return Boolean(res.rowCount && res.rowCount > 0);
  }
};
