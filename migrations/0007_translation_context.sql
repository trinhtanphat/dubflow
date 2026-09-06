ALTER TABLE projects ADD COLUMN translation_style TEXT NOT NULL DEFAULT 'neutral'
  CHECK (translation_style IN ('neutral','natural','formal','casual','cinematic'));

ALTER TABLE projects ADD COLUMN translation_context_revision INTEGER NOT NULL DEFAULT 1
  CHECK (translation_context_revision >= 1);

ALTER TABLE segments ADD COLUMN translation_context_revision INTEGER
  CHECK (translation_context_revision IS NULL OR translation_context_revision >= 1);

CREATE TABLE project_glossary_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_term TEXT NOT NULL,
  source_term_key TEXT NOT NULL,
  preferred_translation TEXT NOT NULL,
  note TEXT,
  case_sensitive INTEGER NOT NULL DEFAULT 0 CHECK (case_sensitive IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_project_glossary_project
  ON project_glossary_entries(project_id, source_term_key, case_sensitive, id);

CREATE UNIQUE INDEX idx_project_glossary_unique
  ON project_glossary_entries(project_id, source_term_key, case_sensitive);

CREATE TRIGGER trg_project_glossary_insert_revision
AFTER INSERT ON project_glossary_entries
BEGIN
  UPDATE projects
  SET translation_context_revision = translation_context_revision + 1,
      updated_at = datetime('now')
  WHERE id = NEW.project_id;
END;

CREATE TRIGGER trg_project_glossary_update_revision
AFTER UPDATE OF source_term, source_term_key, preferred_translation, note, case_sensitive
ON project_glossary_entries
WHEN OLD.source_term IS NOT NEW.source_term
  OR OLD.source_term_key IS NOT NEW.source_term_key
  OR OLD.preferred_translation IS NOT NEW.preferred_translation
  OR OLD.note IS NOT NEW.note
  OR OLD.case_sensitive IS NOT NEW.case_sensitive
BEGIN
  UPDATE projects
  SET translation_context_revision = translation_context_revision + 1,
      updated_at = datetime('now')
  WHERE id = NEW.project_id;
END;

CREATE TRIGGER trg_project_glossary_delete_revision
AFTER DELETE ON project_glossary_entries
BEGIN
  UPDATE projects
  SET translation_context_revision = translation_context_revision + 1,
      updated_at = datetime('now')
  WHERE id = OLD.project_id;
END;
