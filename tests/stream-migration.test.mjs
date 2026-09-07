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

test('current migration filenames upgrade production whose ledger already contains 0012_visual_lipsync.sql', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const files = migrationFiles();
    const preVisualFiles = files.filter((name) => Number(name.slice(0, 4)) <= 11);
    for (const file of preVisualFiles) {
      db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));
    }

    const historicalVisualFilename = files.includes('0012_visual_lipsync.sql')
      ? '0012_visual_lipsync.sql'
      : '0013_visual_lipsync.sql';
    assert.ok(files.includes(historicalVisualFilename), 'expected the historical visual lip-sync migration SQL');
    db.exec(fs.readFileSync(new URL(historicalVisualFilename, migrationsDir), 'utf8'));

    const appliedMigrationNames = new Set([
      ...preVisualFiles,
      '0012_visual_lipsync.sql',
    ]);
    const pendingFiles = files.filter((name) => !appliedMigrationNames.has(name));

    assert.doesNotThrow(() => {
      for (const file of pendingFiles) {
        db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));
      }
    }, 'renaming an already deployed migration must not make Wrangler/D1 reapply its schema changes');

    assert.ok(columns(db, 'projects').includes('stream_video_uid'));
    assert.ok(columns(db, 'project_exports').includes('lip_sync_status'));
  } finally {
    db.close();
  }
});
