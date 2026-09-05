ALTER TABLE usage_events ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
ALTER TABLE usage_events ADD COLUMN phase TEXT NOT NULL DEFAULT 'completed' CHECK (phase IN ('started','completed'));
ALTER TABLE usage_events ADD COLUMN operation_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_operation_phase
  ON usage_events(operation_key, phase)
  WHERE operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_usage_project_created
  ON usage_events(project_id, created_at DESC);
