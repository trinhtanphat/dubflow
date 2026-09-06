PRAGMA defer_foreign_keys = ON;

ALTER TABLE projects ADD COLUMN target_languages_revision INTEGER NOT NULL DEFAULT 1
  CHECK (target_languages_revision >= 1);

CREATE TABLE project_target_languages (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','zh','ja','ko')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','translating','needs_review','ready','exporting','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, target_language)
);

CREATE INDEX idx_project_target_languages_status
  ON project_target_languages(project_id, status, target_language);

INSERT OR IGNORE INTO project_target_languages (
  project_id, target_language, status, created_at, updated_at
)
SELECT
  id,
  'vi',
  CASE
    WHEN status = 'completed' THEN 'completed'
    WHEN status = 'needs_review' THEN 'needs_review'
    WHEN status = 'processing' THEN 'translating'
    ELSE 'pending'
  END,
  created_at,
  updated_at
FROM projects;

INSERT OR IGNORE INTO project_target_languages (
  project_id, target_language, status, created_at, updated_at
)
SELECT project_id, target_language, 'pending', created_at, updated_at
FROM project_targets
WHERE enabled = 1;

ALTER TABLE segment_translations RENAME TO segment_translations_legacy_0009;
DROP INDEX IF EXISTS idx_segment_translations_project_target;

CREATE TABLE segment_translations (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','zh','ja','ko')),
  translated_text TEXT NOT NULL DEFAULT '',
  translation_engine TEXT NOT NULL DEFAULT 'workers-ai',
  translation_status TEXT NOT NULL DEFAULT 'pending',
  translation_context_revision INTEGER
    CHECK (translation_context_revision IS NULL OR translation_context_revision >= 1),
  voice_status TEXT NOT NULL DEFAULT 'pending',
  dubbed_object_key TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  context_revision INTEGER,
  source_segment_version INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (segment_id, target_language)
);

INSERT OR IGNORE INTO segment_translations (
  segment_id,
  project_id,
  target_language,
  translated_text,
  translation_engine,
  translation_status,
  translation_context_revision,
  voice_status,
  dubbed_object_key,
  version,
  context_revision,
  source_segment_version,
  created_at,
  updated_at
)
SELECT
  legacy.segment_id,
  legacy.project_id,
  legacy.target_language,
  legacy.translated_text,
  legacy.translation_engine,
  CASE legacy.translation_status WHEN 'stale' THEN 'pending' ELSE legacy.translation_status END,
  legacy.context_revision,
  CASE WHEN dub.status = 'completed' AND dub.object_key IS NOT NULL THEN 'completed' ELSE 'pending' END,
  CASE WHEN dub.status = 'completed' THEN dub.object_key ELSE NULL END,
  legacy.version,
  legacy.context_revision,
  legacy.source_segment_version,
  legacy.created_at,
  legacy.updated_at
FROM segment_translations_legacy_0009 AS legacy
LEFT JOIN segment_dubs AS dub
  ON dub.segment_id = legacy.segment_id
 AND dub.project_id = legacy.project_id
 AND dub.target_language = legacy.target_language;

INSERT OR IGNORE INTO segment_translations (
  segment_id,
  project_id,
  target_language,
  translated_text,
  translation_engine,
  translation_status,
  translation_context_revision,
  voice_status,
  dubbed_object_key,
  version,
  context_revision,
  source_segment_version,
  created_at,
  updated_at
)
SELECT
  id,
  project_id,
  'vi',
  translated_text,
  translation_engine,
  translation_status,
  translation_context_revision,
  voice_status,
  dubbed_object_key,
  1,
  translation_context_revision,
  version,
  datetime('now'),
  datetime('now')
FROM segments;

DROP TABLE segment_translations_legacy_0009;
CREATE INDEX idx_segment_translations_project_target
  ON segment_translations(project_id, target_language, segment_id);

ALTER TABLE export_shares RENAME TO export_shares_legacy_0009;
DROP INDEX IF EXISTS idx_export_shares_project_created;
DROP INDEX IF EXISTS idx_export_shares_export_id;

ALTER TABLE project_exports RENAME TO project_exports_legacy_0009;
DROP INDEX IF EXISTS idx_project_exports_project_target_created;
DROP INDEX IF EXISTS idx_project_exports_job;
DROP INDEX IF EXISTS idx_project_exports_batch_status;

CREATE TABLE project_exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','zh','ja','ko')),
  output TEXT NOT NULL CHECK (output IN ('dubbed','subtitles')),
  batch_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','exporting','completed','failed','invalidated')),
  export_object_key TEXT,
  subtitle_object_key TEXT,
  error_code TEXT,
  error_message TEXT,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  object_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO project_exports (
  id,
  project_id,
  target_language,
  output,
  batch_id,
  status,
  export_object_key,
  subtitle_object_key,
  error_code,
  error_message,
  job_id,
  generation,
  object_key,
  created_at,
  updated_at
)
SELECT
  id,
  project_id,
  target_language,
  'dubbed',
  batch_id,
  CASE status
    WHEN 'queued' THEN 'pending'
    WHEN 'running' THEN 'exporting'
    WHEN 'completed' THEN 'completed'
    WHEN 'failed' THEN 'failed'
    ELSE 'invalidated'
  END,
  object_key,
  NULL,
  error_code,
  NULL,
  job_id,
  generation,
  object_key,
  created_at,
  updated_at
FROM project_exports_legacy_0009;

INSERT OR IGNORE INTO project_exports (
  id,
  project_id,
  target_language,
  output,
  batch_id,
  status,
  export_object_key,
  subtitle_object_key,
  error_code,
  error_message,
  job_id,
  generation,
  object_key,
  created_at,
  updated_at
)
SELECT
  'legacy_vi_dubbed_' || p.id,
  p.id,
  'vi',
  'dubbed',
  NULL,
  'completed',
  p.export_object_key,
  NULL,
  NULL,
  NULL,
  NULL,
  0,
  p.export_object_key,
  p.updated_at,
  p.updated_at
FROM projects AS p
WHERE p.export_object_key IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM project_exports AS e
    WHERE e.project_id = p.id
      AND e.target_language = 'vi'
      AND e.output = 'dubbed'
      AND e.status = 'completed'
      AND e.export_object_key = p.export_object_key
  );

CREATE TABLE export_shares (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  export_id TEXT REFERENCES project_exports(id) ON DELETE SET NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  export_object_key TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO export_shares (
  id,
  project_id,
  export_id,
  created_by_user_id,
  token_hash,
  token_hint,
  export_object_key,
  expires_at,
  revoked_at,
  created_at
)
SELECT
  id,
  project_id,
  export_id,
  created_by_user_id,
  token_hash,
  token_hint,
  export_object_key,
  expires_at,
  revoked_at,
  created_at
FROM export_shares_legacy_0009;

DROP TABLE export_shares_legacy_0009;
DROP TABLE project_exports_legacy_0009;

CREATE INDEX idx_project_exports_latest
  ON project_exports(project_id, target_language, output, created_at DESC, id DESC);
CREATE INDEX idx_project_exports_batch
  ON project_exports(project_id, batch_id, target_language, output, id);
CREATE INDEX idx_export_shares_project_created
  ON export_shares(project_id, created_at DESC);
CREATE INDEX idx_export_shares_export_id
  ON export_shares(export_id);

ALTER TABLE project_glossary_entries ADD COLUMN target_language TEXT NOT NULL DEFAULT 'vi'
  CHECK (target_language IN ('vi','en','zh','ja','ko'));

DROP INDEX IF EXISTS idx_project_glossary_unique;

CREATE INDEX IF NOT EXISTS idx_project_glossary_project_target
  ON project_glossary_entries(project_id, target_language, source_term_key, case_sensitive, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_glossary_unique_target
  ON project_glossary_entries(project_id, target_language, source_term_key, case_sensitive);

DROP TRIGGER IF EXISTS trg_project_glossary_update_revision;

CREATE TRIGGER trg_project_glossary_update_revision
AFTER UPDATE OF source_term, source_term_key, preferred_translation, note, case_sensitive, target_language
ON project_glossary_entries
WHEN OLD.source_term IS NOT NEW.source_term
  OR OLD.source_term_key IS NOT NEW.source_term_key
  OR OLD.preferred_translation IS NOT NEW.preferred_translation
  OR OLD.note IS NOT NEW.note
  OR OLD.case_sensitive IS NOT NEW.case_sensitive
  OR OLD.target_language IS NOT NEW.target_language
BEGIN
  UPDATE projects
  SET translation_context_revision = translation_context_revision + 1,
      updated_at = datetime('now')
  WHERE id = NEW.project_id;
END;

PRAGMA defer_foreign_keys = OFF;
