-- 0009_file_reviews_and_feedback.sql
-- Creative workflow review, approval, timestamped video comments, and image pin annotations

CREATE TABLE IF NOT EXISTS file_reviews (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(share_id) ON DELETE CASCADE,
    reviewer_name TEXT NOT NULL,
    reviewer_email TEXT,
    status TEXT NOT NULL, -- 'pending', 'approved', 'changes_requested'
    decision_note TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_reviews_file_id ON file_reviews(file_id);

CREATE TABLE IF NOT EXISTS file_review_comments (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL REFERENCES files(share_id) ON DELETE CASCADE,
    author_name TEXT NOT NULL,
    author_email TEXT,
    comment TEXT NOT NULL,
    timestamp_seconds DOUBLE PRECISION,
    coord_x DOUBLE PRECISION,
    coord_y DOUBLE PRECISION,
    resolved INTEGER DEFAULT 0,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_review_comments_file_id ON file_review_comments(file_id);
