PRAGMA defer_foreign_keys = ON;

ALTER TABLE project_exports ADD COLUMN lip_sync_requested INTEGER NOT NULL DEFAULT 0
  CHECK (lip_sync_requested IN (0, 1));

ALTER TABLE project_exports ADD COLUMN lip_sync_provider TEXT;

ALTER TABLE project_exports ADD COLUMN lip_sync_status TEXT NOT NULL DEFAULT 'not_requested'
  CHECK (lip_sync_status IN ('not_requested','queued','processing','completed','failed'));

ALTER TABLE project_exports ADD COLUMN lip_sync_object_key TEXT;

CREATE TABLE provider_media_grants (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_provider_media_grants_token_hash
  ON provider_media_grants(token_hash);

CREATE INDEX idx_provider_media_grants_active_lookup
  ON provider_media_grants(id, token_hash, expires_at);

CREATE INDEX idx_provider_media_grants_project_object
  ON provider_media_grants(project_id, object_key, expires_at);

PRAGMA defer_foreign_keys = OFF;
