-- 0008_brand_and_custom_domains.sql
-- Custom branding, themes, wallpapers, and custom domains for Pro/Enterprise transfer pages

CREATE TABLE IF NOT EXISTS user_brands (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    brand_name TEXT,
    brand_logo_url TEXT,
    brand_color TEXT,
    brand_wallpaper_url TEXT,
    brand_tagline TEXT,
    custom_domain TEXT UNIQUE,
    custom_domain_status TEXT DEFAULT 'pending',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_brands_custom_domain ON user_brands(custom_domain);
