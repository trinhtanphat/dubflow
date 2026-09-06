PRAGMA defer_foreign_keys = ON;

ALTER TABLE projects ADD COLUMN source_generation INTEGER NOT NULL DEFAULT 1
  CHECK (source_generation >= 1);

ALTER TABLE project_exports ADD COLUMN audio_mode TEXT NOT NULL DEFAULT 'dubbed_only'
  CHECK (audio_mode IN ('dubbed_only','duck_original','separated_background'));

CREATE TABLE project_audio_stems (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('background','dialogue')),
  provider TEXT NOT NULL,
  provider_version TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','completed','failed','invalidated')),
  object_key TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_project_audio_stems_active
  ON project_audio_stems(project_id, source_generation, kind, provider)
  WHERE status IN ('pending','completed');

CREATE INDEX idx_project_audio_stems_lookup
  ON project_audio_stems(project_id, source_generation, kind, provider, status, created_at DESC);

CREATE TRIGGER trg_projects_invalidate_audio_stems
AFTER UPDATE OF source_generation ON projects
WHEN NEW.source_generation != OLD.source_generation
BEGIN
  UPDATE project_audio_stems
  SET status = 'invalidated', updated_at = datetime('now')
  WHERE project_id = NEW.id
    AND source_generation != NEW.source_generation
    AND status != 'invalidated';
END;

PRAGMA defer_foreign_keys = OFF;
