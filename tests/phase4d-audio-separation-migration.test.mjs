import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const migrationsDir = new URL('../migrations/', import.meta.url);
const phase4dUrl = new URL('../migrations/0011_phase4d_audio_separation.sql', import.meta.url);

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test('Phase 4D migration extends the full canonical schema without breaking foreign keys', () => {
  assert.equal(fs.existsSync(phase4dUrl), true, '0011_phase4d_audio_separation.sql must exist');

  const files = migrationFiles();
  const prefixes = files.map((name) => name.match(/^(\d+)_/)?.[1]);
  assert.equal(new Set(prefixes).size, prefixes.length, 'migration numeric prefixes must remain unique');
  assert.equal(files.at(-1), '0011_phase4d_audio_separation.sql');

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const file of files) {
    db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));
  }

  assert.ok(columns(db, 'projects').includes('source_generation'));
  assert.ok(columns(db, 'project_exports').includes('audio_mode'));
  assert.deepEqual(
    columns(db, 'project_audio_stems'),
    [
      'id', 'project_id', 'source_generation', 'kind', 'provider', 'provider_version',
      'status', 'object_key', 'error_code', 'error_message', 'created_at', 'updated_at',
    ],
  );
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
