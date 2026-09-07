import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migrationsDir = new URL('../migrations/', import.meta.url);

function migrationFiles() {
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
}

test('production keeps the already-applied visual lip-sync migration filename stable', () => {
  const files = migrationFiles();

  assert.ok(
    files.includes('0012_visual_lipsync.sql'),
    'production already recorded 0012_visual_lipsync.sql in d1_migrations; renaming it makes D1 replay the same schema change',
  );
  assert.ok(files.includes('0012_stream_media.sql'));
  assert.ok(
    !files.includes('0013_visual_lipsync.sql'),
    'the historical visual lip-sync migration must not reappear under a new filename',
  );
});
