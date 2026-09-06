CREATE TABLE IF NOT EXISTS voice_clones (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'elevenlabs' CHECK (provider = 'elevenlabs'),
  provider_voice_id TEXT,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating','verification_required','ready','failed','deleting','deleted')),
  consent_version TEXT NOT NULL,
  consented_at TEXT NOT NULL DEFAULT (datetime('now')),
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_voice_clones_project_status
  ON voice_clones(project_id, status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_voice_clones_provider_identity
  ON voice_clones(provider, provider_voice_id)
  WHERE provider_voice_id IS NOT NULL;
