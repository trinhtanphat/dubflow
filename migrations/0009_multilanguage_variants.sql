PRAGMA foreign_keys = ON;

ALTER TABLE projects ADD COLUMN target_languages_revision INTEGER NOT NULL DEFAULT 1
  CHECK (target_languages_revision >= 1);

CREATE TABLE IF NOT EXISTS project_target_languages (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','zh','ja','ko')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','translating','needs_review','ready','exporting','completed','failed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, target_language)
);

CREATE INDEX IF NOT EXISTS idx_project_target_languages_status
  ON project_target_languages(project_id, status, target_language);

INSERT OR IGNORE INTO project_target_languages (
  project_id,
  target_language,
  status,
  created_at,
  updated_at
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

CREATE TABLE IF NOT EXISTS segment_translations (
  segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL CHECK (target_language IN ('vi','en','zh','ja','ko')),
  translated_text TEXT NOT NULL DEFAULT '',
  translation_engine TEXT NOT NULL DEFAULT 'workers-ai'
    CHECK (translation_engine IN ('workers-ai','google','quality','compare')),
  translation_status TEXT NOT NULL DEFAULT 'pending',
  translation_context_revision INTEGER
    CHECK (translation_context_revision IS NULL OR translation_context_revision >= 1),
  voice_status TEXT NOT NULL DEFAULT 'pending',
  dubbed_object_key TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (segment_id, target_language)
);

CREATE INDEX IF NOT EXISTS idx_segment_translations_project_target
  ON segment_translations(project_id, target_language, segment_id);

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
  datetime('now'),
  datetime('now')
FROM segments;

CREATE TABLE IF NOT EXISTS project_exports (
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_exports_latest
  ON project_exports(project_id, target_language, output, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_project_exports_batch
  ON project_exports(project_id, batch_id, target_language, output, id);

INSERT OR IGNORE INTO project_exports (
  id,
  project_id,
  target_language,
  output,
  status,
  export_object_key,
  created_at,
  updated_at
)
SELECT
  'legacy_vi_dubbed_' || id,
  id,
  'vi',
  'dubbed',
  'completed',
  export_object_key,
  updated_at,
  updated_at
FROM projects
WHERE export_object_key IS NOT NULL;

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
