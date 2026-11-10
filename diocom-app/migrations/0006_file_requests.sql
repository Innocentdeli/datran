-- Migration 0006: File Requests (Receive files securely from clients and colleagues)

CREATE TABLE IF NOT EXISTS file_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slug VARCHAR(120) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    destination_space_id UUID REFERENCES spaces(id) ON DELETE SET NULL,
    max_file_size BIGINT,
    expires_at BIGINT,
    is_active INT NOT NULL DEFAULT 1,
    password_hash VARCHAR(255),
    recipient_public_key TEXT,
    upload_count INT NOT NULL DEFAULT 0,
    total_bytes BIGINT NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_requests_user ON file_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_file_requests_slug ON file_requests(slug);

CREATE TABLE IF NOT EXISTS file_request_uploads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES file_requests(id) ON DELETE CASCADE,
    file_id VARCHAR(64) NOT NULL REFERENCES files(share_id) ON DELETE CASCADE,
    uploader_name VARCHAR(120),
    uploader_email VARCHAR(255),
    uploader_note TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'received',
    uploaded_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_request_uploads_req ON file_request_uploads(request_id);
CREATE INDEX IF NOT EXISTS idx_file_request_uploads_file ON file_request_uploads(file_id);
