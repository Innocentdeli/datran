import { NextResponse } from 'next/server';
import crypto from 'crypto';
import db from '@/db';
import { enforceRateLimit } from '@/lib/rateLimit';
import { withObservability, getLogger } from '@/lib/observability';
import { sendPasswordResetEmail } from '@/lib/email/service';

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const LIMIT = { maxRequests: 5, windowMs: 15 * 60 * 1000 };

async function handlePOST(request: Request) {
  const limited = await enforceRateLimit(request, 'forgot-password', LIMIT);
  if (limited) return limited;

  try {
    const body = await request.json().catch(() => ({}));
    const rawEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';

    if (!rawEmail || !EMAIL_RE.test(rawEmail)) {
      return NextResponse.json({ error: 'Valid email address required' }, { status: 400 });
    }

    // Lookup user
    const res = await db.query('SELECT id, email, name FROM users WHERE LOWER(email) = $1', [rawEmail]);
    const user = res.rows[0] as { id: string; email: string; name: string } | undefined;

    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
      const now = Date.now();
      const expiresAt = now + 20 * 60 * 1000; // 20 minutes TTL
      const resetId = crypto.randomUUID();

      await db.query(
        `INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [resetId, user.id, tokenHash, now, expiresAt]
      );

      const origin = new URL(request.url).origin;
      const resetUrl = `${origin}/auth/reset-password?token=${rawToken}`;

      await sendPasswordResetEmail(user.email, resetUrl);
    }

    // Always return success to prevent user email enumeration
    return NextResponse.json({
      success: true,
      message: 'If an account exists with that email, a password reset link has been dispatched.',
    });
  } catch (err) {
    getLogger().error({ err }, 'forgot-password POST');
    return NextResponse.json({ error: 'Failed to process password reset request' }, { status: 500 });
  }
}

export const POST = withObservability(handlePOST, '/api/auth/forgot-password');
