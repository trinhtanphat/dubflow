import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationsDir = new URL('../../migrations/', import.meta.url);

function applyMigrations(db: DatabaseSync) {
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const file of files) {
    db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
}

describe('browser-local translation provenance migration', () => {
  it('admits browser-opus-mt without weakening the segments translation-engine allowlist', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrations(db);
      db.exec(`
        INSERT INTO users (id, display_name, plan, credit_balance)
        VALUES ('u1', 'User', 'free', 0);
        INSERT INTO projects (id, user_id, title, source_language, target_language, status)
        VALUES ('p1', 'u1', 'Project', 'en', 'vi', 'ready');
        INSERT INTO speakers (id, project_id, label, display_name)
        VALUES ('sp1', 'p1', 'Speaker 1', 'Speaker 1');
        INSERT INTO segments (
          id, project_id, speaker_id, start_ms, end_ms, source_text,
          translated_text, translation_engine, translation_status, voice_status, version
        ) VALUES (
          'seg1', 'p1', 'sp1', 0, 1000, 'hello', 'xin chào',
          'workers-ai', 'completed', 'pending', 1
        );
      `);

      db.prepare(`UPDATE segments SET translation_engine = ? WHERE id = 'seg1'`)
        .run('browser-opus-mt');
      expect(db.prepare(`SELECT translation_engine FROM segments WHERE id = 'seg1'`).get())
        .toEqual({ translation_engine: 'browser-opus-mt' });

      expect(() => db.prepare(`UPDATE segments SET translation_engine = ? WHERE id = 'seg1'`)
        .run('arbitrary-engine'))
        .toThrow();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get('idx_segments_project_split_parent'))
        .toEqual({ name: 'idx_segments_project_split_parent' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
