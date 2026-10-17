-- 0001_initial: the schema exactly as the legacy src/db/schema.ts initializeSchema() produced it, including the
-- later idempotent ALTERs (files.reactor_class / reactor_recipe) and access_events (src/lib/accessEvents.ts).
--
-- Databases created by initializeSchema are BASELINED at this version (marked applied without running it) after
-- the runner verifies their tables/columns — see src/db/migrate.ts LEGACY_BASELINE. Keep the two in sync and
-- NEVER edit this file once released: the runner refuses to start when an applied migration's checksum changes.
-- Put changes in a new numbered file instead.
--
-- Conventions used by the code: ids are TEXT (UUIDs), timestamps are BIGINT milliseconds since epoch, booleans
-- in older tables are INTEGER 0/1. space_files.file_id and inboxes.file_id hold files.share_id (not files.id).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  password_hash TEXT,
  image TEXT,
  provider TEXT,
  role TEXT DEFAULT 'user',
  current_challenge TEXT,
  username TEXT,
  created_at BIGINT NOT NULL
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  share_id TEXT UNIQUE NOT NULL,
  original_name TEXT NOT NULL,
  sanitized_name TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  thumbnail_path TEXT,
  password_hash TEXT,
  is_external INTEGER DEFAULT 0,
  file_size BIGINT NOT NULL,
  mime_type TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  downloads INTEGER DEFAULT 0,
  last_accessed_at BIGINT,
  compression_ratio TEXT,
  compression_speed TEXT,
  tags JSONB,
  summary TEXT,
  is_encrypted INTEGER DEFAULT 0,
  -- AES-GCM IV (base64) for 'v1' client encryption, or the DCE2 marker for the chunked streaming format.
  encryption_iv TEXT,
  similarity_token TEXT,
  -- Rust reactor metadata; NULL for legacy/TS-compressed uploads.
  reactor_class TEXT,
  reactor_recipe TEXT,
  CONSTRAINT files_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE analytics (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  CONSTRAINT analytics_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id)
);

CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  original_size BIGINT NOT NULL,
  hash TEXT UNIQUE NOT NULL
);

CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  settings JSONB,
  quality REAL,
  fitness JSONB,
  data BYTEA,
  CONSTRAINT variants_chunk_id_fkey FOREIGN KEY (chunk_id) REFERENCES chunks(id)
);

CREATE TABLE swarm_nodes (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  ip_address TEXT,
  last_pulse BIGINT NOT NULL,
  status TEXT DEFAULT 'active'
);

CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  counter INTEGER NOT NULL,
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL,
  transports TEXT,
  CONSTRAINT webauthn_credentials_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  details JSONB,
  ip_address TEXT,
  timestamp BIGINT NOT NULL,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  CONSTRAINT audit_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE user_credits (
  user_id TEXT PRIMARY KEY,
  balance REAL DEFAULT 0,
  total_earned REAL DEFAULT 0,
  total_spent REAL DEFAULT 0,
  last_updated BIGINT NOT NULL,
  CONSTRAINT user_credits_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  timestamp BIGINT NOT NULL,
  CONSTRAINT credit_ledger_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  message TEXT,
  created_at BIGINT NOT NULL,
  CONSTRAINT inboxes_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES users(id),
  CONSTRAINT inboxes_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES users(id)
);

CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  is_public INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  CONSTRAINT spaces_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE space_members (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, user_id),
  CONSTRAINT space_members_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id),
  CONSTRAINT space_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE space_files (
  space_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at BIGINT NOT NULL,
  PRIMARY KEY (space_id, file_id),
  CONSTRAINT space_files_space_id_fkey FOREIGN KEY (space_id) REFERENCES spaces(id),
  CONSTRAINT space_files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE lobby_sessions (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  creator_id TEXT,
  joiner_id TEXT,
  status TEXT DEFAULT 'waiting',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE qr_sessions (
  id TEXT PRIMARY KEY,
  creator_id TEXT,
  status TEXT DEFAULT 'waiting',
  file_ids TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

-- Access prediction events (NETWORK_SPEC §5). actor = 'u:<user id>' or 'a:<HMAC(ip+ua)>'; never raw IPs.
CREATE TABLE access_events (
  id BIGSERIAL PRIMARY KEY,
  file_id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  actor TEXT NOT NULL
);

CREATE INDEX idx_files_share_id ON files(share_id);
CREATE INDEX idx_files_expires_at ON files(expires_at);
CREATE INDEX idx_inboxes_recipient ON inboxes(recipient_id);
CREATE INDEX idx_lobby_code ON lobby_sessions(code);
CREATE INDEX idx_access_events_ts ON access_events(ts);
