
const { Client } = require('pg');

const schema = `
-- RESET DATABASE
DROP TABLE IF EXISTS space_files CASCADE;
DROP TABLE IF EXISTS space_members CASCADE;
DROP TABLE IF EXISTS spaces CASCADE;
DROP TABLE IF EXISTS qr_sessions CASCADE;
DROP TABLE IF EXISTS lobby_sessions CASCADE;
DROP TABLE IF EXISTS inboxes CASCADE;
DROP TABLE IF EXISTS credit_ledger CASCADE;
DROP TABLE IF EXISTS user_credits CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS webauthn_credentials CASCADE;
DROP TABLE IF EXISTS analytics CASCADE;
DROP TABLE IF EXISTS variants CASCADE;
DROP TABLE IF EXISTS chunks CASCADE;
DROP TABLE IF EXISTS files CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS swarm_nodes CASCADE;

BEGIN;

-- Users Table
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

-- Files Table
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
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
  similarity_token TEXT
);

-- Analytics Table
CREATE TABLE analytics (
  id TEXT PRIMARY KEY,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  ip_address TEXT,
  user_agent TEXT
);

-- Chunks Table
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  original_size BIGINT NOT NULL,
  hash TEXT UNIQUE NOT NULL
);

-- Variants Table
CREATE TABLE variants (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  algorithm TEXT NOT NULL,
  settings JSONB,
  quality REAL,
  fitness JSONB,
  data BYTEA
);

-- Swarm Nodes Table
CREATE TABLE swarm_nodes (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL,
  ip_address TEXT,
  last_pulse BIGINT NOT NULL,
  status TEXT DEFAULT 'active'
);

-- WebAuthn Credentials
CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BYTEA NOT NULL,
  counter INTEGER NOT NULL,
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL,
  transports TEXT
);

-- Audit Logs
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  details JSONB,
  ip_address TEXT,
  timestamp BIGINT NOT NULL,
  previous_hash TEXT,
  hash TEXT NOT NULL
);

-- User Credits
CREATE TABLE user_credits (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  balance REAL DEFAULT 0,
  total_earned REAL DEFAULT 0,
  total_spent REAL DEFAULT 0,
  last_updated BIGINT NOT NULL
);

-- Credit Ledger
CREATE TABLE credit_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount REAL NOT NULL,
  type TEXT NOT NULL,
  reason TEXT,
  timestamp BIGINT NOT NULL
);

-- Inboxes
CREATE TABLE inboxes (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending',
  message TEXT,
  created_at BIGINT NOT NULL
);

-- Spaces
CREATE TABLE spaces (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT,
  is_public INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  expires_at BIGINT
);

-- Space Members
CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT DEFAULT 'member',
  joined_at BIGINT NOT NULL,
  PRIMARY KEY(space_id, user_id)
);

-- Space Files
CREATE TABLE space_files (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at BIGINT NOT NULL,
  PRIMARY KEY(space_id, file_id)
);

-- Lobby Sessions
CREATE TABLE lobby_sessions (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  joiner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'waiting',
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

-- QR Sessions
CREATE TABLE qr_sessions (
  id TEXT PRIMARY KEY,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'waiting',
  file_ids TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_files_share_id ON files(share_id);
CREATE INDEX IF NOT EXISTS idx_files_expires_at ON files(expires_at);
CREATE INDEX IF NOT EXISTS idx_inboxes_recipient ON inboxes(recipient_id);
CREATE INDEX IF NOT EXISTS idx_lobby_code ON lobby_sessions(code);

COMMIT;
`;

async function migrate() {
    if (!process.env.DATABASE_URL) {
        console.error('❌ DATABASE_URL is not set (e.g. postgres://user:pass@localhost:5432/datran)');
        process.exit(1);
    }

    const client = new Client({ connectionString: process.env.DATABASE_URL });

    try {
        await client.connect();
        console.log('✅ Connected to datran database');
        
        console.log('⏳ Reseting and Running full schema migration...');
        await client.query(schema);
        console.log('✅ Full schema migration complete!');
        
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    } finally {
        await client.end();
    }
}

migrate();
