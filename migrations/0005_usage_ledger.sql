ALTER TABLE usage_events ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE usage_events ADD COLUMN idempotency_key TEXT;
ALTER TABLE usage_events ADD COLUMN credits INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_idempotency
  ON usage_events(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usage_user_provider_created
  ON usage_events(user_id, provider, created_at DESC);
