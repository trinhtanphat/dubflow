PRAGMA defer_foreign_keys = ON;

-- Rebuilding segments is required to widen its CHECK. Back up both tables that
-- reference segments with ON DELETE CASCADE before dropping the legacy parent.
CREATE TABLE segment_translations_browser_local_0013_backup AS
SELECT
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
FROM segment_translations;

CREATE TABLE segment_dubs_browser_local_0013_backup AS
SELECT
  segment_id,
  project_id,
  target_language,
  status,
  object_key,
  voice_provider,
  voice_id,
  translation_version,
  segment_version,
  duration_ms,
  created_at,
  updated_at
FROM segment_dubs;

CREATE TABLE segments_browser_local_0013 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  speaker_id TEXT REFERENCES speakers(id) ON DELETE SET NULL,
  start_ms INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms INTEGER NOT NULL CHECK (end_ms > start_ms),
  source_text TEXT NOT NULL DEFAULT '',
  translated_text TEXT NOT NULL DEFAULT '',
  translation_engine TEXT NOT NULL DEFAULT 'workers-ai'
    CHECK (translation_engine IN ('workers-ai','google','quality','compare','browser-opus-mt')),
  translation_status TEXT NOT NULL DEFAULT 'pending',
  voice_status TEXT NOT NULL DEFAULT 'pending',
  dubbed_object_key TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  split_parent_id TEXT,
  translation_context_revision INTEGER
    CHECK (translation_context_revision IS NULL OR translation_context_revision >= 1)
);

INSERT INTO segments_browser_local_0013 (
  id,
  project_id,
  speaker_id,
  start_ms,
  end_ms,
  source_text,
  translated_text,
  translation_engine,
  translation_status,
  voice_status,
  dubbed_object_key,
  version,
  split_parent_id,
  translation_context_revision
)
SELECT
  id,
  project_id,
  speaker_id,
  start_ms,
  end_ms,
  source_text,
  translated_text,
  translation_engine,
  translation_status,
  voice_status,
  dubbed_object_key,
  version,
  split_parent_id,
  translation_context_revision
FROM segments;

DROP TABLE segments;
ALTER TABLE segments_browser_local_0013 RENAME TO segments;

CREATE INDEX idx_segments_project_start
  ON segments(project_id, start_ms);
CREATE INDEX idx_segments_project_split_parent
  ON segments(project_id, split_parent_id);

INSERT INTO segment_translations (
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
FROM segment_translations_browser_local_0013_backup;

INSERT INTO segment_dubs (
  segment_id,
  project_id,
  target_language,
  status,
  object_key,
  voice_provider,
  voice_id,
  translation_version,
  segment_version,
  duration_ms,
  created_at,
  updated_at
)
SELECT
  segment_id,
  project_id,
  target_language,
  status,
  object_key,
  voice_provider,
  voice_id,
  translation_version,
  segment_version,
  duration_ms,
  created_at,
  updated_at
FROM segment_dubs_browser_local_0013_backup;

DROP TABLE segment_translations_browser_local_0013_backup;
DROP TABLE segment_dubs_browser_local_0013_backup;

-- A browser-local transcript is resumable only for the exact source generation
-- and object key that produced it. This state is intentionally separate from
-- the canonical segments so a later source replacement cannot make stale local
-- inference artifacts appear current.
CREATE TABLE browser_local_inference_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  source_generation INTEGER NOT NULL CHECK (source_generation >= 1),
  source_object_key TEXT NOT NULL,
  asr_model TEXT NOT NULL,
  asr_revision TEXT NOT NULL,
  translation_model TEXT NOT NULL,
  translation_revision TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TRIGGER invalidate_browser_local_inference_state_on_source_change
AFTER UPDATE OF source_generation, source_object_key ON projects
FOR EACH ROW
WHEN OLD.source_generation IS NOT NEW.source_generation
  OR OLD.source_object_key IS NOT NEW.source_object_key
BEGIN
  DELETE FROM browser_local_inference_state
  WHERE project_id = NEW.id
    AND (
      source_generation IS NOT NEW.source_generation
      OR source_object_key IS NOT NEW.source_object_key
    );
END;

PRAGMA defer_foreign_keys = OFF;
