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

test('the complete migration chain upgrades an initial production database without losing base project data', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const files = migrationFiles();
    assert.ok(files.length >= 1, 'expected repository migrations');

    const first = files.shift();
    assert.equal(first, '0001_initial.sql');
    db.exec(fs.readFileSync(new URL(first, migrationsDir), 'utf8'));
    db.exec(`
      INSERT INTO users (id, display_name, plan, credit_balance)
      VALUES ('u1', 'Legacy User', 'free', 50000);
      INSERT INTO projects (
        id, user_id, title, source_language, target_language, status,
        source_object_key, duration_ms, size_bytes
      ) VALUES (
        'p1', 'u1', 'Legacy Project', 'en', 'vi', 'draft',
        'projects/p1/source.mp4', 120000, 1024
      );
      INSERT INTO usage_events (
        id, user_id, project_id, kind, units, provider, cost_basis
      ) VALUES (
        'usage-1', 'u1', 'p1', 'asr_audio_second', 12.5, 'deepgram-nova-3', 0
      );
    `);

    for (const file of files) {
      db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));
    }

    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.ok(columns(db, 'projects').includes('target_languages_revision'));
    assert.ok(columns(db, 'projects').includes('export_object_key'));
    assert.ok(columns(db, 'usage_events').includes('phase'));
    assert.ok(columns(db, 'usage_events').includes('operation_key'));
    assert.ok(columns(db, 'project_exports').includes('output'));
    assert.ok(columns(db, 'project_exports').includes('lip_sync_requested'));
    assert.ok(columns(db, 'project_exports').includes('lip_sync_provider'));
    assert.ok(columns(db, 'project_exports').includes('lip_sync_status'));
    assert.ok(columns(db, 'project_exports').includes('lip_sync_object_key'));
    assert.deepEqual(
      columns(db, 'provider_media_grants'),
      ['id', 'project_id', 'object_key', 'token_hash', 'expires_at', 'consumed_at', 'created_at'],
    );

    assert.deepEqual(
      { ...db.prepare(`
        SELECT id, user_id, title, source_language, target_language, status,
               source_object_key, duration_ms, size_bytes
        FROM projects WHERE id = 'p1'
      `).get() },
      {
        id: 'p1',
        user_id: 'u1',
        title: 'Legacy Project',
        source_language: 'en',
        target_language: 'vi',
        status: 'draft',
        source_object_key: 'projects/p1/source.mp4',
        duration_ms: 120000,
        size_bytes: 1024,
      },
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM usage_events WHERE id = 'usage-1'`).get().count, 1);
  } finally {
    db.close();
  }
});
