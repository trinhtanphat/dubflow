import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

const migrationsDir = new URL('../../migrations/', import.meta.url);
const migrationName = '0013_browser_local_translation_engine.sql';

function migrationFilesBeforeLocal(): string[] {
  return fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name) && name !== migrationName)
    .sort();
}

function applyMigrationsBeforeLocal(db: DatabaseSync): void {
  for (const file of migrationFilesBeforeLocal()) {
    db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));
  }
}

describe('browser-local translation provenance migration', () => {
  it('admits browser-opus-mt while preserving canonical segments, modern translations, dubs, lineage and indexes', () => {
    const db = new DatabaseSync(':memory:');
    try {
      applyMigrationsBeforeLocal(db);
      db.exec(`
        INSERT INTO users (id, display_name, plan, credit_balance)
        VALUES ('u1', 'User', 'free', 0);
        INSERT INTO projects (
          id, user_id, title, source_language, target_language, status,
          source_object_key, duration_ms, size_bytes
        ) VALUES (
          'p1', 'u1', 'Project', 'en', 'vi', 'needs_review',
          'projects/p1/source.mp4', 10000, 1024
        );
        INSERT INTO speakers (id, project_id, label, display_name)
        VALUES ('sp1', 'p1', 'Speaker 1', 'Speaker 1');
        INSERT INTO segments (
          id, project_id, speaker_id, start_ms, end_ms, source_text,
          translated_text, translation_engine, translation_status, voice_status,
          dubbed_object_key, version, split_parent_id, translation_context_revision
        ) VALUES (
          'seg-parent', 'p1', 'sp1', 0, 400, 'parent', 'cha',
          'workers-ai', 'completed', 'pending', NULL, 2, NULL, 3
        );
        INSERT INTO segments (
          id, project_id, speaker_id, start_ms, end_ms, source_text,
          translated_text, translation_engine, translation_status, voice_status,
          dubbed_object_key, version, split_parent_id, translation_context_revision
        ) VALUES (
          'seg-child', 'p1', 'sp1', 500, 1000, 'hello', 'xin chào',
          'google', 'completed', 'completed', 'voices/legacy.pcm', 4,
          'seg-parent', 7
        );
        INSERT INTO segment_translations (
          segment_id, project_id, target_language, translated_text,
          translation_engine, translation_status, translation_context_revision,
          voice_status, dubbed_object_key, version, context_revision,
          source_segment_version
        ) VALUES (
          'seg-child', 'p1', 'vi', 'xin chào', 'google', 'completed', 7,
          'completed', 'voices/legacy.pcm', 9, 7, 4
        );
        INSERT INTO segment_dubs (
          segment_id, project_id, target_language, status, object_key,
          voice_provider, voice_id, translation_version, segment_version, duration_ms
        ) VALUES (
          'seg-child', 'p1', 'vi', 'completed', 'voices/legacy.pcm',
          'legacy', 'voice-1', 9, 4, 500
        );
      `);

      const beforeSegment = { ...db.prepare(`SELECT * FROM segments WHERE id = 'seg-child'`).get() };
      const beforeVariant = { ...db.prepare(`SELECT * FROM segment_translations WHERE segment_id = 'seg-child' AND target_language = 'vi'`).get() };
      const beforeDub = { ...db.prepare(`SELECT * FROM segment_dubs WHERE segment_id = 'seg-child' AND target_language = 'vi'`).get() };

      db.exec(fs.readFileSync(new URL(migrationName, migrationsDir), 'utf8'));

      expect({ ...db.prepare(`SELECT * FROM segments WHERE id = 'seg-child'`).get() }).toEqual(beforeSegment);
      expect({ ...db.prepare(`SELECT * FROM segment_translations WHERE segment_id = 'seg-child' AND target_language = 'vi'`).get() }).toEqual(beforeVariant);
      expect({ ...db.prepare(`SELECT * FROM segment_dubs WHERE segment_id = 'seg-child' AND target_language = 'vi'`).get() }).toEqual(beforeDub);

      db.exec(`
        INSERT INTO segments (
          id, project_id, speaker_id, start_ms, end_ms, source_text,
          translated_text, translation_engine, translation_status, voice_status,
          dubbed_object_key, version, split_parent_id, translation_context_revision
        ) VALUES (
          'seg-local', 'p1', 'sp1', 1100, 1500, 'local', 'cục bộ',
          'browser-opus-mt', 'completed', 'pending', NULL, 1, 'seg-parent', 7
        );
      `);
      expect(db.prepare(`SELECT translation_engine FROM segments WHERE id = 'seg-local'`).get())
        .toEqual({ translation_engine: 'browser-opus-mt' });

      expect(() => db.prepare(`UPDATE segments SET translation_engine = ? WHERE id = 'seg-local'`)
        .run('arbitrary-engine'))
        .toThrow();
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get('idx_segments_project_start'))
        .toEqual({ name: 'idx_segments_project_start' });
      expect(db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get('idx_segments_project_split_parent'))
        .toEqual({ name: 'idx_segments_project_split_parent' });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});
