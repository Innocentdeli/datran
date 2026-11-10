-- 0004_lobby_files: the Live Lobby actually delivers files.
--
-- Until now a lobby only tracked status (waiting -> active -> complete); the host's uploads were never linked to
-- the lobby, so the receiver had no way to find them. file_ids holds a JSON array of files.share_id values the
-- host has dropped into the lobby (same convention as qr_sessions.file_ids).

ALTER TABLE lobby_sessions ADD COLUMN IF NOT EXISTS file_ids TEXT;
