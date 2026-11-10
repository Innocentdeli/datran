-- Migration 0007: Email Delivery Tracking and One-Time Passcode (OTP) Verification

ALTER TABLE files ADD COLUMN IF NOT EXISTS require_email_otp INT NOT NULL DEFAULT 0;
ALTER TABLE files ADD COLUMN IF NOT EXISTS sender_email VARCHAR(255);
ALTER TABLE files ADD COLUMN IF NOT EXISTS custom_message TEXT;

CREATE TABLE IF NOT EXISTS file_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id VARCHAR(64) NOT NULL REFERENCES files(share_id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    token VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'sent',
    sent_at BIGINT NOT NULL,
    opened_at BIGINT,
    downloaded_at BIGINT,
    otp_code_hash VARCHAR(128),
    otp_expires_at BIGINT,
    otp_verified_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_file_recipients_file ON file_recipients(file_id);
CREATE INDEX IF NOT EXISTS idx_file_recipients_token ON file_recipients(token);
CREATE INDEX IF NOT EXISTS idx_file_recipients_email ON file_recipients(email);
