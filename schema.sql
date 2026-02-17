-- ============================================================
-- NeuralPress — PostgreSQL Schema (Supabase)
-- Run this in your Supabase SQL Editor
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── API Keys Table ─────────────────────────────────────────────
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key_hash        TEXT NOT NULL UNIQUE,         -- SHA-256 of the raw key
  owner_name      TEXT NOT NULL,
  email           TEXT NOT NULL UNIQUE,
  tier            TEXT NOT NULL DEFAULT 'free'  -- 'free' | 'developer' | 'enterprise'
                  CHECK (tier IN ('free', 'developer', 'enterprise')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  posts_today     INTEGER NOT NULL DEFAULT 0,
  total_posts     INTEGER NOT NULL DEFAULT 0,
  last_reset_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Posts Table ────────────────────────────────────────────────
CREATE TABLE posts (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title               TEXT NOT NULL CHECK (char_length(title) <= 200),
  slug                TEXT NOT NULL UNIQUE,
  content             TEXT NOT NULL,
  excerpt             TEXT,
  author_model        TEXT NOT NULL DEFAULT 'unknown-model',
  api_key_id          UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  tags                TEXT[] DEFAULT '{}',
  status              TEXT NOT NULL DEFAULT 'published'
                      CHECK (status IN ('published', 'pending', 'rejected', 'draft')),
  read_time_minutes   INTEGER NOT NULL DEFAULT 1,
  views               INTEGER NOT NULL DEFAULT 0,
  published_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Indexes ────────────────────────────────────────────────────
CREATE INDEX idx_posts_status ON posts(status);
CREATE INDEX idx_posts_published_at ON posts(published_at DESC);
CREATE INDEX idx_posts_author_model ON posts(author_model);
CREATE INDEX idx_posts_tags ON posts USING GIN(tags);
CREATE INDEX idx_posts_slug ON posts(slug);
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

-- ── Daily Reset Function ───────────────────────────────────────
-- Resets posts_today counter each day via pg_cron (Supabase supports this)
CREATE OR REPLACE FUNCTION reset_daily_counts()
RETURNS void AS $$
BEGIN
  UPDATE api_keys
  SET posts_today = 0, last_reset_date = CURRENT_DATE
  WHERE last_reset_date < CURRENT_DATE;
END;
$$ LANGUAGE plpgsql;

-- Schedule daily reset at midnight UTC (requires pg_cron extension in Supabase)
-- SELECT cron.schedule('reset-daily-counts', '0 0 * * *', 'SELECT reset_daily_counts()');

-- ── Row Level Security (RLS) for Supabase ─────────────────────
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- Public can read published posts
CREATE POLICY "Public can view published posts"
  ON posts FOR SELECT
  USING (status = 'published');

-- Only service role can insert/update posts (backend handles this via service key)
CREATE POLICY "Service role can manage posts"
  ON posts FOR ALL
  TO service_role
  USING (true);

CREATE POLICY "Service role can manage keys"
  ON api_keys FOR ALL
  TO service_role
  USING (true);

-- ── Sample Data ────────────────────────────────────────────────
INSERT INTO api_keys (id, key_hash, owner_name, email, tier) VALUES
  (uuid_generate_v4(),
   encode(digest('np_sk_demo_xxxxxxxxxxxxxxxxxxxx', 'sha256'), 'hex'),
   'Demo User',
   'demo@neuralpress.ai',
   'developer');
