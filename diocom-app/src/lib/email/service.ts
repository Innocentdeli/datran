import { getLogger } from '@/lib/observability';

export interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface EmailSendResult {
  success: boolean;
  messageId?: string;
  previewUrl?: string;
}

/**
 * Universal email dispatcher for Datran.
 * Supports:
 * - Resend API (`RESEND_API_KEY`)
 * - Generic SMTP / HTTP API
 * - Local dev fallback (logs to console with zero external credentials required)
 */
export async function sendEmail(payload: EmailPayload): Promise<EmailSendResult> {
  const fromEmail = process.env.EMAIL_FROM || 'Datran Security <security@datran.app>';
  const resendApiKey = process.env.RESEND_API_KEY;

  // 1. Resend API
  if (resendApiKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromEmail,
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        return { success: true, messageId: data.id };
      }
      const errorText = await res.text();
      getLogger().error({ status: res.status, errorText }, 'Resend dispatch failed');
    } catch (err) {
      getLogger().error({ err, to: payload.to }, 'Failed to send email via Resend');
    }
  }

  // 2. SendGrid API
  const sendgridApiKey = process.env.SENDGRID_API_KEY;
  if (sendgridApiKey) {
    try {
      const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sendgridApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: payload.to }] }],
          from: { email: fromEmail.replace(/.*<([^>]+)>.*/, '$1').trim() || fromEmail },
          subject: payload.subject,
          content: [
            ...(payload.text ? [{ type: 'text/plain', value: payload.text }] : []),
            { type: 'text/html', value: payload.html }
          ]
        }),
      });

      if (res.ok) {
        const messageId = res.headers.get('x-message-id') || `sg_${Date.now()}`;
        return { success: true, messageId };
      }
      const errText = await res.text();
      getLogger().error({ status: res.status, errText }, 'SendGrid dispatch failed');
    } catch (err) {
      getLogger().error({ err, to: payload.to }, 'Failed to send email via SendGrid');
    }
  }

  // 3. Postmark API
  const postmarkToken = process.env.POSTMARK_SERVER_TOKEN;
  if (postmarkToken) {
    try {
      const res = await fetch('https://api.postmarkapp.com/email', {
        method: 'POST',
        headers: {
          'X-Postmark-Server-Token': postmarkToken,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        body: JSON.stringify({
          From: fromEmail,
          To: payload.to,
          Subject: payload.subject,
          HtmlBody: payload.html,
          TextBody: payload.text,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        return { success: true, messageId: data.MessageID };
      }
      const errText = await res.text();
      getLogger().error({ status: res.status, errText }, 'Postmark dispatch failed');
    } catch (err) {
      getLogger().error({ err, to: payload.to }, 'Failed to send email via Postmark');
    }
  }

  // 4. Custom HTTP Webhook Dispatch
  const emailWebhookUrl = process.env.EMAIL_WEBHOOK_URL;
  if (emailWebhookUrl) {
    try {
      const res = await fetch(emailWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromEmail, ...payload })
      });
      if (res.ok) {
        return { success: true, messageId: `wh_${Date.now()}` };
      }
    } catch (err) {
      getLogger().error({ err }, 'Failed to send email via webhook');
    }
  }

  // Local development / zero-config fallback
  getLogger().info(
    {
      to: payload.to,
      subject: payload.subject,
      contentSnippet: payload.text || payload.html.slice(0, 120),
    },
    '[EMAIL DISPATCHED] (Development / Local Dispatch)'
  );

  return {
    success: true,
    messageId: `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

/** Password Reset Email */
export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<EmailSendResult> {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #05070A; color: #F8FAFC; margin: 0; padding: 40px 20px; }
          .container { max-width: 520px; margin: 0 auto; background: #0A0F1A; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; }
          .logo { font-size: 20px; font-weight: 800; color: #00F2FF; margin-bottom: 24px; }
          h1 { font-size: 20px; font-weight: 700; margin-bottom: 16px; color: #ffffff; }
          p { font-size: 14px; line-height: 1.6; color: #94A3B8; margin-bottom: 24px; }
          .btn { display: inline-block; background-color: #00F2FF; color: #04121A; font-weight: 700; font-size: 14px; padding: 12px 24px; border-radius: 10px; text-decoration: none; }
          .footer { font-size: 11px; color: #64748B; margin-top: 32px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 16px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">⚡ DATRAN</div>
          <h1>Reset your password</h1>
          <p>We received a request to reset the password for your Datran account (<strong>${to}</strong>). Click the button below to choose a new password. This link will expire in 20 minutes.</p>
          <p><a href="${resetUrl}" class="btn">Reset Password</a></p>
          <p style="font-size: 12px; color: #64748B;">If you did not request this reset, you can safely ignore this email. Your password will remain unchanged.</p>
          <div class="footer">
            Datran Inc. • Zero-Knowledge Encrypted Transfers
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to,
    subject: 'Reset your Datran password',
    html,
    text: `Reset your Datran password by visiting: ${resetUrl} (link expires in 20 minutes)`,
  });
}

/** Account Verification Email */
export async function sendVerificationEmail(to: string, verifyUrl: string): Promise<EmailSendResult> {
  const html = `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #05070A; color: #F8FAFC; margin: 0; padding: 40px 20px; }
          .container { max-width: 520px; margin: 0 auto; background: #0A0F1A; border: 1px solid rgba(255,255,255,0.1); border-radius: 16px; padding: 32px; }
          .logo { font-size: 20px; font-weight: 800; color: #00F2FF; margin-bottom: 24px; }
          h1 { font-size: 20px; font-weight: 700; margin-bottom: 16px; color: #ffffff; }
          p { font-size: 14px; line-height: 1.6; color: #94A3B8; margin-bottom: 24px; }
          .btn { display: inline-block; background-color: #00F2FF; color: #04121A; font-weight: 700; font-size: 14px; padding: 12px 24px; border-radius: 10px; text-decoration: none; }
          .footer { font-size: 11px; color: #64748B; margin-top: 32px; border-top: 1px solid rgba(255,255,255,0.06); padding-top: 16px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="logo">⚡ DATRAN</div>
          <h1>Verify your email address</h1>
          <p>Welcome to Datran. Please confirm your email address (<strong>${to}</strong>) to activate your account and access encrypted cloud features.</p>
          <p><a href="${verifyUrl}" class="btn">Verify Email Address</a></p>
          <div class="footer">
            Datran Inc. • Fast, Private & Secure File Sharing
          </div>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to,
    subject: 'Verify your Datran account',
    html,
    text: `Verify your Datran account: ${verifyUrl}`,
  });
}

/** Download Notification Notice */
export async function sendDownloadNotice(to: string, filename: string, downloads: number): Promise<EmailSendResult> {
  const html = `
    <!DOCTYPE html>
    <html>
      <body style="background:#05070A; color:#F8FAFC; font-family:sans-serif; padding:30px;">
        <div style="max-width:500px; margin:0 auto; background:#0A0F1A; border:1px solid rgba(255,255,255,0.1); border-radius:14px; padding:24px;">
          <h2 style="color:#00F2FF; margin-top:0;">File Download Notice</h2>
          <p style="color:#94A3B8; font-size:14px;">Your shared file <strong>${filename}</strong> was just downloaded (Total downloads: ${downloads}).</p>
          <p style="color:#64748B; font-size:12px;">You can manage your active links and expire them anytime from your Datran dashboard.</p>
        </div>
      </body>
    </html>
  `;

  return sendEmail({
    to,
    subject: `Your file "${filename}" was downloaded`,
    html,
    text: `Your shared file "${filename}" was just downloaded (Total downloads: ${downloads}).`,
  });
}
