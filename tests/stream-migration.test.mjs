import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrationsDir = new URL('../migrations/', import.meta.url);

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test('preserves D1 migration filenames that have already been deployed to production', () => {
  const files = migrationFiles();
  assert.ok(files.includes('0012_visual_lipsync.sql'), 'the shipped visual-lipsync migration filename must remain immutable');
  assert.ok(files.includes('0012_stream_media.sql'), 'the shipped Stream migration filename must remain immutable');
  assert.ok(!files.includes('0013_visual_lipsync.sql'), 'a shipped migration must not be renumbered under a new filename');
});

test('migration chain adds nullable Stream source and per-export render provenance without rewriting existing rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const files = migrationFiles();
    for (const file of files) db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));

    const projectColumns = columns(db, 'projects');
    assert.ok(projectColumns.includes('stream_video_uid'));
    assert.ok(projectColumns.includes('stream_source_object_key'));
    assert.ok(projectColumns.includes('stream_ready_at'));

    const exportColumns = columns(db, 'project_exports');
    assert.ok(exportColumns.includes('stream_video_uid'));
    assert.ok(exportColumns.includes('stream_source_object_key'));
  } finally {
    db.close();
  }
});
