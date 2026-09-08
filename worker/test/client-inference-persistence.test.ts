import fs from 'node:fs';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import {
  ClientInferenceCommitError,
  ClientInferenceRepository,
} from '../src/db/client-inference';
import {
  LOCAL_INFERENCE_ASR,
  LOCAL_INFERENCE_TRANSLATION,
  normalizeClientInferenceInput,
} from '../src/domain/client-inference';

const migrationsDir = new URL('../../migrations/', import.meta.url);

class SqliteStatement implements D1StatementLike {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    readonly values: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): D1StatementLike {
    return new SqliteStatement(this.db, this.sql, values as SQLInputValue[]);
  }

  private prepared(): StatementSync {
    return this.db.prepare(this.sql);
  }

  async run(): Promise<D1RunResultLike> {
    const result = this.prepared().run(...this.values);
    return { changes: Number(result.changes) };
  }

  async all<T>(): Promise<{ results?: T[] }> {
    return { results: this.prepared().all(...this.values) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return (this.prepared().get(...this.values) as T | undefined) ?? null;
  }
}

class SqliteD1 implements D1DatabaseLike {
  batchCalls = 0;
  failBatch = false;
  beforeBatch?: () => void;

  constructor(readonly db: DatabaseSync) {}

  prepare(sql: string): D1StatementLike {
    return new SqliteStatement(this.db, sql);
  }

  async batch(statements: D1StatementLike[]): Promise<unknown[]> {
    this.batchCalls += 1;
    this.beforeBatch?.();
    if (this.failBatch) throw new Error('simulated batch failure');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const results: unknown[] = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec('COMMIT');
      return results;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

function applyMigrations(db: DatabaseSync): void {
  const files = fs.readdirSync(migrationsDir)
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  for (const file of files) db.exec(fs.readFileSync(new URL(file, migrationsDir), 'utf8'));
}

function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO users (id, display_name, plan, credit_balance)
    VALUES ('u1', 'User', 'free', 0);
    INSERT INTO projects (
      id, user_id, title, source_language, target_language, status,
      source_object_key, duration_ms, size_bytes
    ) VALUES (
      'p1', 'u1', 'Project', 'en', 'vi', 'ready',
      'projects/p1/source/current.mp4', 4000, 1024
    );
    UPDATE projects SET source_generation = 3 WHERE id = 'p1';
    INSERT INTO project_target_languages (project_id, target_language, status)
    VALUES ('p1', 'vi', 'ready');
    INSERT INTO speakers (id, project_id, label, display_name)
    VALUES ('old-speaker', 'p1', 'Old', 'Old');
    INSERT INTO segments (
      id, project_id, speaker_id, start_ms, end_ms, source_text,
      translated_text, translation_engine, translation_status, voice_status, version
    ) VALUES (
      'old-segment', 'p1', 'old-speaker', 0, 4000, 'old', 'cũ',
      'workers-ai', 'completed', 'completed', 2
    );
    INSERT INTO segment_translations (
      segment_id, project_id, target_language, translated_text, translation_engine,
      translation_status, voice_status, version, source_segment_version
    ) VALUES (
      'old-segment', 'p1', 'vi', 'cũ', 'workers-ai', 'completed', 'completed', 2, 2
    );
    INSERT INTO project_exports (
      id, project_id, target_language, output, status, export_object_key, generation
    ) VALUES (
      'export-old', 'p1', 'vi', 'dubbed', 'completed', 'projects/p1/exports/vi/old.mp4', 3
    );
  `);
}

function input() {
  return normalizeClientInferenceInput('p1', {
    expectedSourceGeneration: 3,
    expectedSourceObjectKey: 'projects/p1/source/current.mp4',
    durationMs: 4_000,
    asr: { ...LOCAL_INFERENCE_ASR },
    translation: { ...LOCAL_INFERENCE_TRANSLATION },
    segments: [
      { id: 's1', startMs: 0, endMs: 1_500, sourceText: 'Hello' },
      { id: 's2', startMs: 1_500, endMs: 4_000, sourceText: 'world' },
    ],
    translations: [
      { segmentId: 's1', translatedText: 'Xin chào' },
      { segmentId: 's2', translatedText: 'thế giới' },
    ],
  });
}

function harness() {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  seed(db);
  const d1 = new SqliteD1(db);
  return { db, d1, repository: new ClientInferenceRepository(d1) };
}

describe('browser-local client inference atomic persistence', () => {
  it('replaces canonical transcript and vi variants in one batch while preserving source identity', async () => {
    const h = harness();
    try {
      const result = await h.repository.commit('p1', 'u1', input());
      expect(h.d1.batchCalls).toBe(1);
      expect(result).toMatchObject({
        sourceGeneration: 3,
        sourceObjectKey: 'projects/p1/source/current.mp4',
        durationMs: 4_000,
        speaker: { id: 'browser-local:p1:speaker-1' },
        asr: LOCAL_INFERENCE_ASR,
        translation: LOCAL_INFERENCE_TRANSLATION,
      });

      expect(h.db.prepare(`SELECT id FROM segments WHERE project_id = 'p1' ORDER BY start_ms`).all())
        .toEqual([{ id: 's1' }, { id: 's2' }]);
      expect(h.db.prepare(`SELECT id FROM speakers WHERE project_id = 'p1' ORDER BY id`).all())
        .toEqual([{ id: 'browser-local:p1:speaker-1' }]);
      expect(h.db.prepare(`SELECT DISTINCT speaker_id FROM segments WHERE project_id = 'p1'`).all())
        .toEqual([{ speaker_id: 'browser-local:p1:speaker-1' }]);
      expect(h.db.prepare(`SELECT translated_text, translation_engine, translation_status, voice_status, dubbed_object_key, translation_context_revision FROM segments WHERE id = 's1'`).get())
        .toEqual({
          translated_text: 'Xin chào',
          translation_engine: 'browser-opus-mt',
          translation_status: 'completed',
          voice_status: 'pending',
          dubbed_object_key: null,
          translation_context_revision: 1,
        });
      expect(h.db.prepare(`SELECT translated_text, translation_engine, translation_status, voice_status, dubbed_object_key, translation_context_revision, context_revision FROM segment_translations WHERE segment_id = 's1' AND target_language = 'vi'`).get())
        .toEqual({
          translated_text: 'Xin chào',
          translation_engine: 'browser-opus-mt',
          translation_status: 'completed',
          voice_status: 'pending',
          dubbed_object_key: null,
          translation_context_revision: 1,
          context_revision: 1,
        });
      expect(h.db.prepare(`SELECT status FROM project_exports WHERE id = 'export-old'`).get())
        .toEqual({ status: 'invalidated' });
      expect(h.db.prepare(`SELECT status, source_generation, source_object_key, duration_ms FROM projects WHERE id = 'p1'`).get())
        .toEqual({
          status: 'needs_review',
          source_generation: 3,
          source_object_key: 'projects/p1/source/current.mp4',
          duration_ms: 4000,
        });
      expect(h.db.prepare(`SELECT status FROM project_target_languages WHERE project_id = 'p1' AND target_language = 'vi'`).get())
        .toEqual({ status: 'needs_review' });
    } finally {
      h.db.close();
    }
  });

  it('rejects stale source identity with zero writes and safe canonical metadata', async () => {
    const h = harness();
    try {
      const stale = { ...input(), expectedSourceGeneration: 2 };
      await expect(h.repository.commit('p1', 'u1', stale)).rejects.toMatchObject({
        code: 'LOCAL_INFERENCE_SOURCE_CONFLICT',
        source: {
          sourceGeneration: 3,
          sourceObjectKey: 'projects/p1/source/current.mp4',
        },
      });
      expect(h.d1.batchCalls).toBe(0);
      expect(h.db.prepare(`SELECT id FROM segments WHERE project_id = 'p1'`).all())
        .toEqual([{ id: 'old-segment' }]);
    } finally {
      h.db.close();
    }
  });

  it('fails closed if source identity changes after admission but before the atomic batch', async () => {
    const h = harness();
    try {
      h.d1.beforeBatch = () => {
        h.db.exec(`
          UPDATE projects
          SET source_generation = 4,
              source_object_key = 'projects/p1/source/new.mp4'
          WHERE id = 'p1'
        `);
      };

      await expect(h.repository.commit('p1', 'u1', input())).rejects.toMatchObject({
        code: 'LOCAL_INFERENCE_SOURCE_CONFLICT',
        source: {
          sourceGeneration: 4,
          sourceObjectKey: 'projects/p1/source/new.mp4',
        },
      });

      expect(h.d1.batchCalls).toBe(1);
      expect(h.db.prepare(`SELECT id FROM segments WHERE project_id = 'p1'`).all())
        .toEqual([{ id: 'old-segment' }]);
      expect(h.db.prepare(`SELECT id FROM speakers WHERE project_id = 'p1'`).all())
        .toEqual([{ id: 'old-speaker' }]);
      expect(h.db.prepare(`SELECT status FROM project_exports WHERE id = 'export-old'`).get())
        .toEqual({ status: 'completed' });
    } finally {
      h.db.close();
    }
  });

  it('rejects busy project, busy vi target and busy exports with zero writes', async () => {
    const projectBusy = harness();
    try {
      projectBusy.db.exec(`UPDATE projects SET status = 'processing' WHERE id = 'p1'`);
      await expect(projectBusy.repository.commit('p1', 'u1', input())).rejects.toMatchObject({
        code: 'LOCAL_INFERENCE_BUSY',
      });
      expect(projectBusy.d1.batchCalls).toBe(0);
    } finally {
      projectBusy.db.close();
    }

    const targetBusy = harness();
    try {
      targetBusy.db.exec(`UPDATE project_target_languages SET status = 'translating' WHERE project_id = 'p1' AND target_language = 'vi'`);
      await expect(targetBusy.repository.commit('p1', 'u1', input())).rejects.toMatchObject({
        code: 'LOCAL_INFERENCE_BUSY',
      });
      expect(targetBusy.d1.batchCalls).toBe(0);
    } finally {
      targetBusy.db.close();
    }

    const exportBusy = harness();
    try {
      exportBusy.db.exec(`
        INSERT INTO project_exports (
          id, project_id, target_language, output, status, generation
        ) VALUES ('export-busy', 'p1', 'vi', 'dubbed', 'pending', 4)
      `);
      await expect(exportBusy.repository.commit('p1', 'u1', input())).rejects.toMatchObject({
        code: 'LOCAL_INFERENCE_BUSY',
      });
      expect(exportBusy.d1.batchCalls).toBe(0);
    } finally {
      exportBusy.db.close();
    }
  });

  it('rejects an active export for any project target before replacing canonical segments', async () => {
    const h = harness();
    try {
      h.db.exec(`
        INSERT INTO project_exports (
          id, project_id, target_language, output, status, generation
        ) VALUES ('export-ja-busy', 'p1', 'ja', 'dubbed', 'pending', 4)
      `);
      await expect(h.repository.commit('p1', 'u1', input())).rejects.toMatchObject({
        code: 'LOCAL_INFERENCE_BUSY',
      });
      expect(h.d1.batchCalls).toBe(0);
      expect(h.db.prepare(`SELECT id FROM segments WHERE project_id = 'p1'`).all())
        .toEqual([{ id: 'old-segment' }]);
    } finally {
      h.db.close();
    }
  });

  it('requires an enabled vi target and preserves canonical duration inside tolerance', async () => {
    const missingTarget = harness();
    try {
      missingTarget.db.exec(`DELETE FROM project_target_languages WHERE project_id = 'p1' AND target_language = 'vi'`);
      await expect(missingTarget.repository.commit('p1', 'u1', input())).rejects.toMatchObject({
        code: 'LOCAL_INFERENCE_UNAVAILABLE',
      });
      expect(missingTarget.d1.batchCalls).toBe(0);
    } finally {
      missingTarget.db.close();
    }

    const duration = harness();
    try {
      const withinTolerance = { ...input(), durationMs: 4_500 };
      const result = await duration.repository.commit('p1', 'u1', withinTolerance);
      expect(result.durationMs).toBe(4_000);
      expect(duration.db.prepare(`SELECT duration_ms FROM projects WHERE id = 'p1'`).get())
        .toEqual({ duration_ms: 4000 });
    } finally {
      duration.db.close();
    }
  });

  it('fails closed when D1 batch fails without exposing partial state', async () => {
    const h = harness();
    try {
      h.d1.failBatch = true;
      await expect(h.repository.commit('p1', 'u1', input())).rejects.toBeInstanceOf(ClientInferenceCommitError);
      expect(h.d1.batchCalls).toBe(1);
      expect(h.db.prepare(`SELECT id FROM segments WHERE project_id = 'p1'`).all())
        .toEqual([{ id: 'old-segment' }]);
      expect(h.db.prepare(`SELECT status FROM project_exports WHERE id = 'export-old'`).get())
        .toEqual({ status: 'completed' });
    } finally {
      h.db.close();
    }
  });

  it('refuses to emulate atomicity when D1 batch is unavailable', async () => {
    const h = harness();
    try {
      const noBatch: D1DatabaseLike = { prepare: h.d1.prepare.bind(h.d1) };
      const repository = new ClientInferenceRepository(noBatch);
      await expect(repository.commit('p1', 'u1', input())).rejects.toMatchObject({
        code: 'LOCAL_INFERENCE_COMMIT_FAILED',
      });
      expect(h.db.prepare(`SELECT id FROM segments WHERE project_id = 'p1'`).all())
        .toEqual([{ id: 'old-segment' }]);
    } finally {
      h.db.close();
    }
  });
});
