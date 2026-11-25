-- ReelCraft Cloudflare D1 Schema
-- Run via: wrangler d1 execute reelcraft-db --file=./schema.sql

CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT DEFAULT '',
  videos_created INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_active_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default application settings (non-sensitive defaults)
INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('site_name', 'ReelCraft'),
  ('watermark_text', 'ReelCraft'),
  ('watermark_enabled', 'true'),
  ('reward_ad_enabled', 'false'),
  ('ad_provider', 'adsgram'),
  ('adsgram_block_id', ''),
  ('monetag_zone_id', ''),
  ('richads_pub_id', ''),
  ('gigapub_id', '');
