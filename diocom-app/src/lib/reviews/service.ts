import db from '@/db';
import { randomUUID } from 'crypto';
import { sendEmail } from '@/lib/email/service';
import { AuditLogger } from '@/lib/AuditLogger';

export interface FileReview {
  id: string;
  file_id: string;
  reviewer_name: string;
  reviewer_email: string | null;
  status: 'pending' | 'approved' | 'changes_requested';
  decision_note: string | null;
  created_at: number;
  updated_at: number;
}

export interface FileReviewComment {
  id: string;
  file_id: string;
  author_name: string;
  author_email: string | null;
  comment: string;
  timestamp_seconds: number | null;
  coord_x: number | null;
  coord_y: number | null;
  resolved: number;
  created_at: number;
}

export const ReviewService = {
  /** Fetch all reviews and comments for a file */
  async getReviewsAndComments(fileId: string): Promise<{
    reviews: FileReview[];
    comments: FileReviewComment[];
    approvedCount: number;
    changesRequestedCount: number;
  }> {
    const reviewsRes = await db.query('SELECT * FROM file_reviews WHERE file_id = $1 ORDER BY updated_at DESC', [fileId]);
    const commentsRes = await db.query('SELECT * FROM file_review_comments WHERE file_id = $1 ORDER BY created_at ASC', [fileId]);

    const reviews = reviewsRes.rows as FileReview[];
    const comments = commentsRes.rows as FileReviewComment[];

    const approvedCount = reviews.filter((r) => r.status === 'approved').length;
    const changesRequestedCount = reviews.filter((r) => r.status === 'changes_requested').length;

    return {
      reviews,
      comments,
      approvedCount,
      changesRequestedCount,
    };
  },

  /** Submit or update an approval decision on a file */
  async submitReview(params: {
    fileId: string;
    reviewerName: string;
    reviewerEmail?: string;
    status: 'approved' | 'changes_requested';
    decisionNote?: string;
    origin?: string;
  }): Promise<FileReview> {
    const reviewerName = params.reviewerName.trim();
    if (!reviewerName) throw new Error('Reviewer name is required');

    const reviewerEmail = params.reviewerEmail?.trim() || null;
    const decisionNote = params.decisionNote?.trim() || null;
    const now = Date.now();

    const existingRes = await db.query('SELECT * FROM file_reviews WHERE file_id = $1 AND reviewer_name = $2', [
      params.fileId,
      reviewerName,
    ]);

    let review: FileReview;

    if (existingRes.rows.length > 0) {
      const existing = existingRes.rows[0];
      await db.query(
        'UPDATE file_reviews SET status = $1, decision_note = $2, updated_at = $3 WHERE id = $4',
        [params.status, decisionNote, now, existing.id]
      );
      review = {
        ...existing,
        status: params.status,
        decision_note: decisionNote,
        updated_at: now,
      } as FileReview;
    } else {
      const id = randomUUID();
      await db.query(`
        INSERT INTO file_reviews (
          id, file_id, reviewer_name, reviewer_email, status, decision_note, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        id,
        params.fileId,
        reviewerName,
        reviewerEmail,
        params.status,
        decisionNote,
        now,
        now,
      ]);

      review = {
        id,
        file_id: params.fileId,
        reviewer_name: reviewerName,
        reviewer_email: reviewerEmail,
        status: params.status,
        decision_note: decisionNote,
        created_at: now,
        updated_at: now,
      };
    }

    // Lookup file to notify owner/sender
    const fileRes = await db.query('SELECT original_name, sender_email, user_id FROM files WHERE share_id = $1', [params.fileId]);
    const file = fileRes.rows[0];

    let targetEmail = file?.sender_email;
    if (!targetEmail && file?.user_id) {
      const uRes = await db.query('SELECT email FROM users WHERE id = $1', [file.user_id]);
      targetEmail = uRes.rows[0]?.email;
    }

    if (targetEmail) {
      const isApproved = params.status === 'approved';
      const actionTitle = isApproved ? 'Approved Your Transfer' : 'Requested Changes';
      const statusEmoji = isApproved ? '✅' : '✏️';

      await sendEmail({
        to: targetEmail,
        subject: `[Datran Review] ${statusEmoji} ${reviewerName} ${actionTitle} ("${file?.original_name}")`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 540px; margin: 0 auto; padding: 24px;">
            <div style="background: #0f172a; padding: 20px; border-radius: 12px; color: #fff; margin-bottom: 20px;">
              <h2 style="margin: 0 0 8px 0; font-size: 20px; color: ${isApproved ? '#34d399' : '#fbbf24'};">
                ${statusEmoji} File Review ${actionTitle}
              </h2>
              <p style="margin: 0; font-size: 14px; color: #cbd5e1;">
                <strong>${reviewerName}</strong> has marked <strong>"${file?.original_name}"</strong> as <strong>${isApproved ? 'Approved' : 'Changes Requested'}</strong>.
              </p>
            </div>
            ${decisionNote ? `
              <div style="background: #f8fafc; border-left: 4px solid ${isApproved ? '#10b981' : '#f59e0b'}; padding: 14px; margin-bottom: 20px; border-radius: 4px; font-size: 14px; color: #334155;">
                "${decisionNote}"
              </div>
            ` : ''}
            <p style="font-size: 12px; color: #64748b;">
              Review submitted at ${new Date(now).toLocaleString()} via Datran Review &amp; Approve.
            </p>
          </div>
        `,
      }).catch((err) => console.error('[REVIEW] Notification email error:', err));
    }

    await AuditLogger.record({
      action: 'FILE_REVIEW_SUBMITTED',
      resource: params.fileId,
      details: `${reviewerName} marked file as ${params.status}`,
    });

    return review;
  },

  /** Add a timestamped or image-coordinate pinned comment */
  async addComment(params: {
    fileId: string;
    authorName: string;
    authorEmail?: string;
    comment: string;
    timestampSeconds?: number | null;
    coordX?: number | null;
    coordY?: number | null;
  }): Promise<FileReviewComment> {
    const authorName = params.authorName.trim();
    if (!authorName) throw new Error('Author name is required');
    const comment = params.comment.trim();
    if (!comment) throw new Error('Comment cannot be empty');

    const id = randomUUID();
    const now = Date.now();
    const timestampSeconds = params.timestampSeconds !== undefined ? params.timestampSeconds : null;
    const coordX = params.coordX !== undefined ? params.coordX : null;
    const coordY = params.coordY !== undefined ? params.coordY : null;
    const authorEmail = params.authorEmail?.trim() || null;

    await db.query(`
      INSERT INTO file_review_comments (
        id, file_id, author_name, author_email, comment,
        timestamp_seconds, coord_x, coord_y, resolved, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      id,
      params.fileId,
      authorName,
      authorEmail,
      comment,
      timestampSeconds,
      coordX,
      coordY,
      0,
      now,
    ]);

    return {
      id,
      file_id: params.fileId,
      author_name: authorName,
      author_email: authorEmail,
      comment,
      timestamp_seconds: timestampSeconds,
      coord_x: coordX,
      coord_y: coordY,
      resolved: 0,
      created_at: now,
    };
  },

  /** Mark a comment as resolved or unresolved */
  async toggleCommentResolved(commentId: string, resolved: boolean): Promise<boolean> {
    const resVal = resolved ? 1 : 0;
    await db.query('UPDATE file_review_comments SET resolved = $1 WHERE id = $2', [resVal, commentId]);
    return true;
  },
};
