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

test('migration chain adds nullable Stream provenance without rewriting existing projects', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const files = migrationFiles();
    for (const file of files) db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));

    const projectColumns = columns(db, 'projects');
    assert.ok(projectColumns.includes('stream_video_uid'));
    assert.ok(projectColumns.includes('stream_source_object_key'));
    assert.ok(projectColumns.includes('stream_ready_at'));
  } finally {
    db.close();
  }
});
