import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1RunResultLike, D1StatementLike } from '../src/db/projects';
import { SegmentRepository } from '../src/db/segments';

type SegmentRow = {
  id: string;
  project_id: string;
  speaker_id: string | null;
  start_ms: number;
  end_ms: number;
  source_text: string;
  translated_text: string;
  translation_engine: string;
  translation_status: string;
  voice_status: string;
  version: number;
  split_parent_id: string | null;
};

type ProjectRow = { id: string; user_id: string; duration_ms: number };

class Statement implements D1StatementLike {
  values: unknown[] = [];

  constructor(public readonly db: RecordingDb, public readonly sql: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async run(): Promise<D1RunResultLike> {
    this.db.runs.push(this);
    if (this.sql.includes('UPDATE segments') && this.sql.includes('SET source_text = ?')) {
      const [
        sourceText,
        translatedText,
        speakerId,
        startMs,
        endMs,
        voiceStatus,
        segmentId,
        projectId,
        userId,
        expectedVersion,
      ] = this.values as [string, string, string | null, number, number, string, string, string, string, number | undefined];
      const project = this.db.projects.find((item) => item.id === projectId && item.user_id === userId);
      const row = project ? this.db.rows.find((item) => item.id === segmentId && item.project_id === projectId) : undefined;
      if (!row || (expectedVersion !== undefined && row.version !== expectedVersion)) {
        return { meta: { changes: 0 } };
      }
      row.source_text = sourceText;
      row.translated_text = translatedText;
      row.speaker_id = speakerId;
      row.start_ms = startMs;
      row.end_ms = endMs;
      row.voice_status = voiceStatus;
      row.version += 1;
      return { meta: { changes: 1 } };
    }

    if (this.sql.includes('UPDATE segments') && this.sql.includes('SET translated_text = ?')) {
      const [translatedText, engine, segmentId, projectId, userId, expectedVersion] = this.values as [string, string, string, string, string, number | undefined];
      const project = this.db.projects.find((item) => item.id === projectId && item.user_id === userId);
      const row = project ? this.db.rows.find((item) => item.id === segmentId && item.project_id === projectId) : undefined;
      if (!row || (expectedVersion !== undefined && row.version !== expectedVersion)) {
        return { meta: { changes: 0 } };
      }
      row.translated_text = translatedText;
      row.translation_engine = engine;
      row.translation_status = 'completed';
      row.version += 1;
      return { meta: { changes: 1 } };
    }

    return { meta: { changes: 1 } };
  }

  async all<T>() {
    if (!this.sql.includes('FROM segments s')) return { results: [] as T[] };
    const [projectId, userId] = this.values as [string, string];
    const project = this.db.projects.find((item) => item.id === projectId && item.user_id === userId);
    if (!project) return { results: [] as T[] };
    const rows = this.db.rows
      .filter((row) => row.project_id === projectId)
      .sort((left, right) => left.start_ms - right.start_ms || left.id.localeCompare(right.id));
    return { results: rows.map((row) => ({ ...row })) as T[] };
  }

  async first<T>() {
    if (this.sql.includes('FROM segments s')) {
      const [projectId, segmentId, userId] = this.values as [string, string, string];
      const project = this.db.projects.find((item) => item.id === projectId && item.user_id === userId);
      if (!project) return null;
      const row = this.db.rows.find((item) => item.project_id === projectId && item.id === segmentId);
      return (row ? { ...row } : null) as T | null;
    }

    if (this.sql.includes('FROM projects')) {
      const [projectId, userId] = this.values as [string, string];
      const row = this.db.projects.find((item) => item.id === projectId && item.user_id === userId);
      return (row ? { ...row } : null) as T | null;
    }

    return null;
  }
}

class RecordingDb implements D1DatabaseLike {
  projects: ProjectRow[] = [{ id: 'project-1', user_id: 'dev-user', duration_ms: 10_000 }];
  rows: SegmentRow[] = [
    {
      id: 's1', project_id: 'project-1', speaker_id: 'speaker-1', start_ms: 1_000, end_ms: 3_000,
      source_text: 'hello beautiful world', translated_text: 'xin chao the gioi', translation_engine: 'workers-ai',
      translation_status: 'completed', voice_status: 'completed', version: 3, split_parent_id: null,
    },
    {
      id: 's2', project_id: 'project-1', speaker_id: 'speaker-1', start_ms: 4_000, end_ms: 5_000,
      source_text: 'next', translated_text: 'tiep', translation_engine: 'workers-ai',
      translation_status: 'completed', voice_status: 'completed', version: 1, split_parent_id: null,
    },
  ];
  runs: Statement[] = [];
  batches: Statement[][] = [];

  prepare(sql: string) {
    return new Statement(this, sql);
  }

  async batch(statements: D1StatementLike[]) {
    this.batches.push(statements as Statement[]);
    return statements.map(() => ({ meta: { changes: 1 } }));
  }
}

describe('SegmentRepository durable revision-aware mutations', () => {
  it('uses SQL compare-and-swap for a legal timing edit and returns the canonical revision', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    const updated = await repository.updateSegment('project-1', 's1', 'dev-user', 3, {
      startMs: 1_200,
      endMs: 3_200,
    });

    expect(updated).toMatchObject({ id: 's1', startMs: 1_200, endMs: 3_200, voiceStatus: 'pending', version: 4 });
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]?.sql).toMatch(/version\s*=\s*\?/i);
    expect(db.runs[0]?.values.at(-1)).toBe(3);
  });

  it('rejects a stale timing revision without changing the canonical row', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    await expect(repository.updateSegment('project-1', 's1', 'dev-user', 2, {
      translatedText: 'stale local text',
    })).rejects.toMatchObject({ code: 'SEGMENT_VERSION_CONFLICT' });

    expect(db.rows[0]?.translated_text).toBe('xin chao the gioi');
    expect(db.rows[0]?.version).toBe(3);
  });

  it('rejects overlap against current project state without writing', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    await expect(repository.updateSegment('project-1', 's1', 'dev-user', 3, {
      startMs: 2_500,
      endMs: 4_500,
    })).rejects.toMatchObject({ code: 'SEGMENT_OVERLAP' });
    expect(db.runs).toHaveLength(0);
  });

  it('atomically splits only when the parent revision still matches', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    const result = await repository.splitSegment('project-1', 's1', 'dev-user', 3, 2_000);

    expect(result.left).toMatchObject({ id: 's1', startMs: 1_000, endMs: 2_000, voiceStatus: 'pending', version: 4 });
    expect(result.right.id).toEqual(expect.any(String));
    expect(result.right.id).not.toBe('s1');
    expect(result.right).toMatchObject({ projectId: 'project-1', startMs: 2_000, endMs: 3_000, voiceStatus: 'pending', version: 1 });
    expect(result.right.splitParentId).toBe('s1');
    expect(result.left.sourceText).toBe('hello beautiful');
    expect(result.right.sourceText).toBe('world');
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batches[0]?.[0]?.sql).toMatch(/version\s*=\s*\?/i);
    expect(db.batches[0]?.[1]?.sql).toMatch(/version\s*=\s*\?/i);
    expect(db.batches[0]?.flatMap((statement) => statement.values)).toContain(3);
  });

  it('rejects a stale split revision before batching any write', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    await expect(repository.splitSegment('project-1', 's1', 'dev-user', 2, 2_000))
      .rejects.toMatchObject({ code: 'SEGMENT_VERSION_CONFLICT' });
    expect(db.batches).toHaveLength(0);
  });

  it('rejects an invalid split point without batching any write', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    await expect(repository.splitSegment('project-1', 's1', 'dev-user', 3, 1_050))
      .rejects.toMatchObject({ code: 'INVALID_SPLIT_POINT' });
    expect(db.batches).toHaveLength(0);
  });

  it('restores only when parent and child revisions and lineage all match', async () => {
    const db = new RecordingDb();
    db.rows.push({
      ...db.rows[0]!,
      id: 'child-1',
      start_ms: 2_000,
      end_ms: 3_000,
      source_text: 'world',
      translated_text: 'gioi',
      version: 2,
      split_parent_id: 's1',
    });
    const repository = new SegmentRepository(db);

    const restored = await repository.restoreSplit('project-1', 's1', 'dev-user', 3, 'child-1', 2, {
      startMs: 1_000,
      endMs: 3_000,
      sourceText: 'hello beautiful world',
      translatedText: 'xin chao the gioi',
      speakerId: 'speaker-1',
    });

    expect(restored).toMatchObject({ id: 's1', startMs: 1_000, endMs: 3_000, voiceStatus: 'pending', version: 4 });
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
    expect(db.batches[0]?.[0]?.sql).toMatch(/version\s*=\s*\?/i);
    expect(db.batches[0]?.[1]?.sql).toMatch(/version\s*=\s*\?/i);
    const values = db.batches[0]?.flatMap((statement) => statement.values) ?? [];
    expect(values).toContain(3);
    expect(values).toContain(2);
  });

  it('rejects stale parent or child revisions before restore mutation', async () => {
    const db = new RecordingDb();
    db.rows.push({ ...db.rows[0]!, id: 'child-1', version: 2, split_parent_id: 's1' });
    const repository = new SegmentRepository(db);
    const original = {
      startMs: 1_000, endMs: 3_000, sourceText: 'x', translatedText: 'y', speakerId: 'speaker-1',
    };

    await expect(repository.restoreSplit('project-1', 's1', 'dev-user', 2, 'child-1', 2, original))
      .rejects.toMatchObject({ code: 'SEGMENT_VERSION_CONFLICT' });
    await expect(repository.restoreSplit('project-1', 's1', 'dev-user', 3, 'child-1', 1, original))
      .rejects.toMatchObject({ code: 'SEGMENT_VERSION_CONFLICT' });
    expect(db.batches).toHaveLength(0);
  });

  it('persists translation results with compare-and-swap instead of overwriting a newer segment', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    const updated = await repository.setTranslationResult('project-1', 's1', 'dev-user', 3, 'ban dich moi', 'workers-ai');
    expect(updated).toMatchObject({ translatedText: 'ban dich moi', translationEngine: 'workers-ai', version: 4 });

    await expect(repository.setTranslationResult('project-1', 's1', 'dev-user', 3, 'stale overwrite', 'workers-ai'))
      .rejects.toMatchObject({ code: 'SEGMENT_VERSION_CONFLICT' });
    expect(db.rows[0]?.translated_text).toBe('ban dich moi');
    expect(db.rows[0]?.version).toBe(4);
  });

  it('fails closed for unrelated lineage and non-owner access', async () => {
    const db = new RecordingDb();
    db.rows.push({
      ...db.rows[0]!, id: 'child-other', start_ms: 3_000, end_ms: 3_500, version: 2, split_parent_id: 'someone-else',
    });
    const repository = new SegmentRepository(db);

    await expect(repository.restoreSplit('project-1', 's1', 'dev-user', 3, 'child-other', 2, {
      startMs: 1_000, endMs: 3_000, sourceText: 'x', translatedText: 'y', speakerId: 'speaker-1',
    })).rejects.toMatchObject({ code: 'SPLIT_LINEAGE_MISMATCH' });

    await expect(repository.splitSegment('project-1', 's1', 'other-user', 3, 2_000))
      .rejects.toMatchObject({ code: 'SEGMENT_NOT_FOUND' });
    expect(db.batches).toHaveLength(0);
  });
});
