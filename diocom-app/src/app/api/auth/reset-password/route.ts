import { NextResponse } from 'next/server';
import crypto from 'crypto';
import db from '@/db';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, getLogger } from '@/lib/observability';
import { hashPassword } from '@/lib/security';

const LIMIT = { maxRequests: 5, windowMs: 15 * 60 * 1000 };

async function handlePOST(request: Request) {
  const limited = await enforceRateLimit(request, 'reset-password', LIMIT);
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const { token, newPassword } = body as { token?: string; newPassword?: string };

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'Valid reset token is required' }, { status: 400 });
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
      return NextResponse.json({ error: 'Password must be at least 8 characters long' }, { status: 400 });
    }

    const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
    const now = Date.now();

    const resetRes = await db.query(
      `SELECT * FROM password_resets WHERE token_hash = $1 AND expires_at > $2 AND used_at IS NULL`,
      [tokenHash, now]
    );

    const resetRecord = resetRes.rows[0] as { id: string; user_id: string } | undefined;
    if (!resetRecord) {
      return NextResponse.json(
        { error: 'This password reset link is invalid or has expired. Please request a new one.' },
        { status: 400 }
      );
    }

    const newHash = await hashPassword(newPassword);

    // Update password
    await db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [newHash, resetRecord.user_id]);

    // Mark token as used
    await db.query(`UPDATE password_resets SET used_at = $1 WHERE id = $2`, [now, resetRecord.id]);

    return NextResponse.json({
      success: true,
      message: 'Password has been successfully updated. You may now sign in.',
    });
  } catch (err) {
    getLogger().error({ err }, 'reset-password POST');
    return NextResponse.json({ error: 'Failed to reset password' }, { status: 500 });
  }
}

export const POST = withObservability(handlePOST, '/api/auth/reset-password');
