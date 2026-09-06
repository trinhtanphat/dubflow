PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS project_targets (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','ja','ko','zh')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, target_language)
);

CREATE INDEX IF NOT EXISTS idx_project_targets_project_enabled
  ON project_targets(project_id, enabled, target_language);

CREATE TABLE IF NOT EXISTS segment_translations (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','ja','ko','zh')),
  translated_text TEXT NOT NULL DEFAULT '',
  translation_engine TEXT NOT NULL DEFAULT 'workers-ai',
  translation_status TEXT NOT NULL DEFAULT 'pending' CHECK (translation_status IN ('pending','completed','failed','stale')),
  context_revision INTEGER,
  source_segment_version INTEGER NOT NULL CHECK (source_segment_version >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (segment_id, target_language)
);

CREATE INDEX IF NOT EXISTS idx_segment_translations_project_target
  ON segment_translations(project_id, target_language, segment_id);

CREATE TABLE IF NOT EXISTS segment_dubs (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','ja','ko','zh')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed','stale')),
  object_key TEXT,
  voice_provider TEXT,
  voice_id TEXT,
  translation_version INTEGER NOT NULL CHECK (translation_version >= 1),
  segment_version INTEGER NOT NULL CHECK (segment_version >= 1),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (segment_id, target_language)
);

CREATE INDEX IF NOT EXISTS idx_segment_dubs_project_target
  ON segment_dubs(project_id, target_language, segment_id);

CREATE TABLE IF NOT EXISTS project_exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','ja','ko','zh')),
  status TEXT NOT NULL CHECK (status IN ('queued','running','failed','completed','cancelled')),
  object_key TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  error_code TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_exports_project_target_created
  ON project_exports(project_id, target_language, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_exports_job
  ON project_exports(job_id);
CREATE INDEX IF NOT EXISTS idx_project_exports_batch_status
  ON project_exports(project_id, batch_id, status);

ALTER TABLE export_shares ADD COLUMN export_id TEXT REFERENCES project_exports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_export_shares_export_id ON export_shares(export_id);
