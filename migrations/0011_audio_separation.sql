ALTER TABLE projects
  ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0 CHECK (source_revision >= 0);

UPDATE projects
SET source_revision = 1
WHERE source_object_key IS NOT NULL;

ALTER TABLE project_exports
  ADD COLUMN mix_mode TEXT NOT NULL DEFAULT 'dubbed_only'
  CHECK (mix_mode IN ('dubbed_only','preserve_background'));

CREATE TABLE project_audio_separations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  source_object_key TEXT NOT NULL,
  source_size_bytes INTEGER CHECK (source_size_bytes IS NULL OR source_size_bytes >= 0),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','failed','invalidated')),
  dialogue_object_key TEXT,
  background_object_key TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (project_id, source_revision, provider, model_digest)
);

CREATE INDEX idx_project_audio_separations_project_source
  ON project_audio_separations(project_id, source_revision, provider, model_digest);
CREATE INDEX idx_project_audio_separations_job
  ON project_audio_separations(job_id);
