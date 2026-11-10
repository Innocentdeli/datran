-- 0005_abuse_and_moderation: abuse reporting, moderation queue, malware tracking, and password reset.

CREATE TABLE IF NOT EXISTS abuse_reports (
  id TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  reporter_email TEXT,
  reason TEXT NOT NULL,
  details TEXT,
  status TEXT DEFAULT 'pending',
  ip_address TEXT,
  created_at BIGINT NOT NULL,
  resolved_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_abuse_reports_share_id ON abuse_reports(share_id);
CREATE INDEX IF NOT EXISTS idx_abuse_reports_status ON abuse_reports(status);

ALTER TABLE files ADD COLUMN IF NOT EXISTS is_disabled INTEGER DEFAULT 0;
ALTER TABLE files ADD COLUMN IF NOT EXISTS disabled_reason TEXT;
ALTER TABLE files ADD COLUMN IF NOT EXISTS malware_status TEXT DEFAULT 'clean';

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_banned INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS password_resets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT,
  CONSTRAINT password_resets_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id);
