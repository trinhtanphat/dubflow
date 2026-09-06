ALTER TABLE projects
  ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1 CHECK (source_revision >= 1);

ALTER TABLE project_exports
  ADD COLUMN mix_mode TEXT NOT NULL DEFAULT 'dubbed_only'
  CHECK (mix_mode IN ('dubbed_only','preserve_background'));

CREATE TABLE audio_separations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','completed','failed','invalidated')),
  background_object_key TEXT,
  dialogue_object_key TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, source_revision, provider, model_digest)
);

CREATE INDEX idx_audio_separations_project_source
  ON audio_separations(project_id, source_revision, provider, model_digest);
CREATE INDEX idx_audio_separations_job
  ON audio_separations(job_id);
