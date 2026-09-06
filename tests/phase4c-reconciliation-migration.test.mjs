import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const main0009 = read('migrations/0009_multilang_exports.sql');
const reconciliation0010 = read('migrations/0010_multilanguage_variants.sql');

function prePhase4CSchema(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE users (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_language TEXT NOT NULL DEFAULT 'vi',
      status TEXT NOT NULL DEFAULT 'created',
      export_object_key TEXT,
      translation_context_revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      translated_text TEXT NOT NULL DEFAULT '',
      translation_engine TEXT NOT NULL DEFAULT 'workers-ai',
      translation_status TEXT NOT NULL DEFAULT 'pending',
      translation_context_revision INTEGER,
      voice_status TEXT NOT NULL DEFAULT 'pending',
      dubbed_object_key TEXT,
      version INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE jobs (
      id TEXT PRIMARY KEY
    );

    CREATE TABLE export_shares (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      token_hint TEXT NOT NULL,
      export_object_key TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_export_shares_project_created
      ON export_shares(project_id, created_at DESC);

    CREATE TABLE project_glossary_entries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_term TEXT NOT NULL,
      source_term_key TEXT NOT NULL,
      preferred_translation TEXT NOT NULL,
      note TEXT,
      case_sensitive INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_project_glossary_unique
      ON project_glossary_entries(project_id, source_term_key, case_sensitive);

    CREATE TRIGGER trg_project_glossary_update_revision
    AFTER UPDATE OF source_term, source_term_key, preferred_translation, note, case_sensitive
    ON project_glossary_entries
    BEGIN
      UPDATE projects
      SET translation_context_revision = translation_context_revision + 1,
          updated_at = datetime('now')
      WHERE id = NEW.project_id;
    END;
  `);
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name);
}

test('0010 upgrades the already-merged main 0009 schema without losing Phase 4C data or share identity', () => {
  const db = new DatabaseSync(':memory:');
  try {
    prePhase4CSchema(db);
    db.exec(`
      INSERT INTO users (id) VALUES ('u1');
      INSERT INTO projects (
        id, user_id, target_language, status, export_object_key, translation_context_revision, created_at, updated_at
      ) VALUES (
        'p1', 'u1', 'vi', 'completed', 'projects/p1/export/dubbed.mp4', 2,
        '2026-09-06T00:00:00.000Z', '2026-09-06T00:00:00.000Z'
      );
      INSERT INTO segments (
        id, project_id, translated_text, translation_engine, translation_status,
        translation_context_revision, voice_status, dubbed_object_key, version
      ) VALUES (
        's1', 'p1', 'Xin chao', 'workers-ai', 'completed', 2, 'completed',
        'projects/p1/dubbed/s1.mp3', 3
      );
      INSERT INTO project_glossary_entries (
        id, project_id, source_term, source_term_key, preferred_translation, note, case_sensitive
      ) VALUES ('g1', 'p1', 'Cloud', 'cloud', 'Dam may', NULL, 0);
    `);

    db.exec(main0009);
    db.exec(`
      INSERT INTO project_targets (project_id, target_language, enabled)
      VALUES ('p1', 'ja', 1);

      INSERT INTO segment_translations (
        segment_id, project_id, target_language, translated_text, translation_engine,
        translation_status, context_revision, source_segment_version, version
      ) VALUES (
        's1', 'p1', 'ja', 'Konnichiwa', 'workers-ai', 'completed', 2, 3, 4
      );

      INSERT INTO segment_dubs (
        segment_id, project_id, target_language, status, object_key, voice_provider,
        voice_id, translation_version, segment_version, duration_ms
      ) VALUES (
        's1', 'p1', 'ja', 'completed', 'projects/p1/voices/ja/s1/4.mp3',
        'elevenlabs', 'voice-ja', 4, 3, 1200
      );

      INSERT INTO jobs (id) VALUES ('j1');
      INSERT INTO project_exports (
        id, project_id, batch_id, target_language, status, object_key, job_id, error_code, generation
      ) VALUES (
        'exp-ja', 'p1', 'batch-1', 'ja', 'completed',
        'projects/p1/exports/ja/exp-ja.mp4', 'j1', NULL, 1
      );

      INSERT INTO export_shares (
        id, project_id, export_id, created_by_user_id, token_hash, token_hint,
        export_object_key, expires_at, revoked_at, created_at
      ) VALUES (
        'share-1', 'p1', 'exp-ja', 'u1', 'hash-1', 'hint-1',
        'projects/p1/exports/ja/exp-ja.mp4', '2026-10-01T00:00:00.000Z', NULL,
        '2026-09-06T00:00:00.000Z'
      );
    `);

    db.exec(reconciliation0010);

    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

    for (const name of ['translation_context_revision', 'voice_status', 'dubbed_object_key', 'context_revision', 'source_segment_version']) {
      assert.ok(columns(db, 'segment_translations').includes(name), `segment_translations must retain ${name}`);
    }
    for (const name of ['output', 'batch_id', 'export_object_key', 'subtitle_object_key', 'error_message', 'job_id', 'generation', 'object_key']) {
      assert.ok(columns(db, 'project_exports').includes(name), `project_exports must retain ${name}`);
    }
    assert.ok(columns(db, 'export_shares').includes('export_id'));

    assert.deepEqual(
      db.prepare(`
        SELECT translated_text, translation_status, voice_status, dubbed_object_key,
               translation_context_revision, context_revision, source_segment_version, version
        FROM segment_translations
        WHERE segment_id = 's1' AND target_language = 'ja'
      `).get(),
      {
        translated_text: 'Konnichiwa',
        translation_status: 'completed',
        voice_status: 'completed',
        dubbed_object_key: 'projects/p1/voices/ja/s1/4.mp3',
        translation_context_revision: 2,
        context_revision: 2,
        source_segment_version: 3,
        version: 4,
      },
    );

    assert.deepEqual(
      db.prepare(`
        SELECT target_language, output, batch_id, status, export_object_key, job_id, generation, object_key
        FROM project_exports WHERE id = 'exp-ja'
      `).get(),
      {
        target_language: 'ja',
        output: 'dubbed',
        batch_id: 'batch-1',
        status: 'completed',
        export_object_key: 'projects/p1/exports/ja/exp-ja.mp4',
        job_id: 'j1',
        generation: 1,
        object_key: 'projects/p1/exports/ja/exp-ja.mp4',
      },
    );

    assert.equal(
      db.prepare(`SELECT export_id FROM export_shares WHERE id = 'share-1'`).get().export_id,
      'exp-ja',
    );

    const targets = db.prepare(`
      SELECT target_language FROM project_target_languages
      WHERE project_id = 'p1' ORDER BY target_language
    `).all().map((row) => row.target_language);
    assert.deepEqual(targets, ['ja', 'vi']);

    db.exec(`
      INSERT INTO project_exports (
        id, project_id, target_language, output, batch_id, status
      ) VALUES ('exp-zh-sub', 'p1', 'zh', 'subtitles', NULL, 'pending');
      UPDATE project_exports SET status = 'invalidated' WHERE id = 'exp-zh-sub';

      INSERT INTO segment_translations (
        segment_id, project_id, target_language, translated_text, translation_status,
        translation_context_revision, voice_status, version
      ) VALUES ('s1', 'p1', 'zh', 'Ni hao', 'completed', 2, 'pending', 1);
    `);

    assert.equal(db.prepare(`SELECT status FROM project_exports WHERE id = 'exp-zh-sub'`).get().status, 'invalidated');
    assert.equal(
      db.prepare(`SELECT translated_text FROM segment_translations WHERE segment_id = 's1' AND target_language = 'zh'`).get().translated_text,
      'Ni hao',
    );
  } finally {
    db.close();
  }
});
