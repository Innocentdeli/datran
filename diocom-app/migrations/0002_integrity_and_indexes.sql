-- 0002: fixes for bugs the legacy schema had against the code, plus indexes for the queries the app runs.

-- audit_logs.details: AuditLogger writes free text ("Viewed shared file") and hashes that exact string, so JSONB
-- rejected every insert ("invalid input syntax for type json"; the error was swallowed and nothing was logged).
-- #>> '{}' turns any existing JSON string back into its plain text.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'audit_logs' AND column_name = 'details') = 'jsonb' THEN
    ALTER TABLE audit_logs ALTER COLUMN details TYPE TEXT USING details #>> '{}';
  END IF;
END $$;

-- inboxes.file_id and space_files.file_id hold files.share_id. Databases created by the old scripts/apply_schema.js
-- had foreign keys from them to files(id), which made every inbox send / space add fail. Drop any such key.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT con.conrelid::regclass::text AS tbl, con.conname FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE con.contype = 'f' AND con.confrelid = 'files'::regclass AND att.attname = 'file_id'
      AND con.conrelid IN ('inboxes'::regclass, 'space_files'::regclass)
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', fk.tbl, fk.conname);
  END LOOP;
END $$;

-- analytics rows referenced files(id) without ON DELETE, so the expired-file cleanup (DELETE FROM files) failed
-- for every file that had ever been viewed. Analytics events belong to their file: cascade.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT con.conname FROM pg_constraint con
    WHERE con.conrelid = 'analytics'::regclass AND con.contype = 'f' AND con.confrelid = 'files'::regclass
  LOOP
    EXECUTE format('ALTER TABLE analytics DROP CONSTRAINT %I', fk.conname);
  END LOOP;
END $$;
ALTER TABLE analytics
  ADD CONSTRAINT analytics_file_id_fkey FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE;

-- Redundant: UNIQUE constraints already create these indexes.
DROP INDEX IF EXISTS idx_files_share_id;
DROP INDEX IF EXISTS idx_lobby_code;

-- Query-path indexes (IF NOT EXISTS: baselined databases may already have some created by hand).
CREATE INDEX IF NOT EXISTS idx_files_user_created ON files(user_id, created_at DESC);   -- dashboard, search
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(LOWER(email));                -- passkey login
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);                       -- @handle lookup
CREATE INDEX IF NOT EXISTS idx_analytics_file_id ON analytics(file_id);                 -- cascade deletes
CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp DESC);        -- recent activity
CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp);           -- hash chain
CREATE INDEX IF NOT EXISTS idx_credit_ledger_user ON credit_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_space_members_user ON space_members(user_id);            -- "spaces I'm in"
CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_variants_chunk ON variants(chunk_id);
CREATE INDEX IF NOT EXISTS idx_swarm_nodes_pulse ON swarm_nodes(last_pulse);
