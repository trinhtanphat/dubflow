ALTER TABLE projects ADD COLUMN stream_video_uid TEXT;
ALTER TABLE projects ADD COLUMN stream_source_object_key TEXT;
ALTER TABLE projects ADD COLUMN stream_ready_at TEXT;

ALTER TABLE project_exports ADD COLUMN stream_video_uid TEXT;
ALTER TABLE project_exports ADD COLUMN stream_source_object_key TEXT;
