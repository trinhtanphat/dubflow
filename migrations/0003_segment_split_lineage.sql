ALTER TABLE segments ADD COLUMN split_parent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_segments_project_split_parent
ON segments(project_id, split_parent_id);
