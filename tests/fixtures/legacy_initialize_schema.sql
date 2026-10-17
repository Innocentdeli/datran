-- Test fixture: schema created by an older legacy diocom-app/src/db/schema.ts initializeSchema() (before files.reactor_*
-- and access_events existed). Used by tests/db_migrate_pg.test.ts to prove baselining + repair.
CREATE TABLE IF NOT EXISTS users (
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

CREATE TABLE IF NOT EXISTS files (
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
  encryption_iv TEXT,
  similarity_token TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS analytics (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  FOREIGN KEY(file_id) REFERENCES files(id)
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  original_size BIGINT NOT NULL,
  hash TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS variants (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  algorithm TEXT NOT NULL,
  settings JSONB,
  quality REAL,
  fitness JSONB,
  data BYTEA,
  FOREIGN KEY(chunk_id) REFERENCES chunks(id)
);

CREATE TABLE IF NOT EXISTS swarm_nodes (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  ip_address TEXT,
  last_pulse BIGINT NOT NULL,
  status TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  public_key BYTEA NOT NULL,
  counter INTEGER NOT NULL,
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL,
  transports TEXT,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  details JSONB,
  ip_address TEXT,
  timestamp BIGINT NOT NULL,
  previous_hash TEXT,
  hash TEXT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS user_credits (
  user_id TEXT PRIMARY KEY,
  balance REAL DEFAULT 0,
  total_earned REAL DEFAULT 0,
  total_spent REAL DEFAULT 0,
  last_updated BIGINT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  timestamp BIGINT NOT NULL,
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS inboxes (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  message TEXT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY(sender_id) REFERENCES users(id),
  FOREIGN KEY(recipient_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  is_public INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  expires_at BIGINT,
  FOREIGN KEY(owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS space_members (
  space_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  PRIMARY KEY(space_id, user_id),
  FOREIGN KEY(space_id) REFERENCES spaces(id),
  FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS space_files (
  space_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at BIGINT NOT NULL,
  PRIMARY KEY(space_id, file_id),
  FOREIGN KEY(space_id) REFERENCES spaces(id),
  FOREIGN KEY(uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS lobby_sessions (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  creator_id TEXT,
  joiner_id TEXT,
  status TEXT DEFAULT 'waiting',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS qr_sessions (
  id TEXT PRIMARY KEY,
  creator_id TEXT,
  status TEXT DEFAULT 'waiting',
  file_ids TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);



CREATE INDEX IF NOT EXISTS idx_files_share_id ON files(share_id);
CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
CREATE INDEX IF NOT EXISTS idx_inboxes_recipient ON inboxes(recipient_id);
CREATE INDEX IF NOT EXISTS idx_lobby_code ON lobby_sessions(code);
