import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1StatementLike } from '../src/db/projects';
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

  async run() {
    this.db.runs.push(this);
    return {};
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
    return [];
  }
}

describe('SegmentRepository durable timing mutations', () => {
  it('accepts a legal timing edit and invalidates voice state', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    const updated = await (repository as any).updateSegment('project-1', 's1', 'dev-user', {
      startMs: 1_200,
      endMs: 3_200,
    });

    expect(updated).toMatchObject({ id: 's1', startMs: 1_200, endMs: 3_200, voiceStatus: 'pending', version: 4 });
    expect(db.runs).toHaveLength(1);
  });

  it('rejects overlap against current project state without writing', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    await expect((repository as any).updateSegment('project-1', 's1', 'dev-user', {
      startMs: 2_500,
      endMs: 4_500,
    })).rejects.toMatchObject({ code: 'SEGMENT_OVERLAP' });
    expect(db.runs).toHaveLength(0);
  });

  it('atomically splits using a Worker-generated child id and pending voice state', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    const result = await (repository as any).splitSegment('project-1', 's1', 'dev-user', 2_000);

    expect(result.left).toMatchObject({ id: 's1', startMs: 1_000, endMs: 2_000, voiceStatus: 'pending' });
    expect(result.right.id).toEqual(expect.any(String));
    expect(result.right.id).not.toBe('s1');
    expect(result.right).toMatchObject({ projectId: 'project-1', startMs: 2_000, endMs: 3_000, voiceStatus: 'pending' });
    expect(result.right.splitParentId).toBe('s1');
    expect(result.left.sourceText).toBe('hello beautiful');
    expect(result.right.sourceText).toBe('world');
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
  });

  it('rejects an invalid split point without batching any write', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    await expect((repository as any).splitSegment('project-1', 's1', 'dev-user', 1_050))
      .rejects.toMatchObject({ code: 'INVALID_SPLIT_POINT' });
    expect(db.batches).toHaveLength(0);
  });

  it('restores only a child that belongs to the original split lineage', async () => {
    const db = new RecordingDb();
    db.rows.push({
      ...db.rows[0],
      id: 'child-1',
      start_ms: 2_000,
      end_ms: 3_000,
      source_text: 'world',
      translated_text: 'gioi',
      split_parent_id: 's1',
    });
    const repository = new SegmentRepository(db);

    const restored = await (repository as any).restoreSplit('project-1', 's1', 'child-1', 'dev-user', {
      startMs: 1_000,
      endMs: 3_000,
      sourceText: 'hello beautiful world',
      translatedText: 'xin chao the gioi',
      speakerId: 'speaker-1',
    });

    expect(restored).toMatchObject({ id: 's1', startMs: 1_000, endMs: 3_000, voiceStatus: 'pending' });
    expect(db.batches).toHaveLength(1);
    expect(db.batches[0]).toHaveLength(2);
  });

  it('fails closed for unrelated lineage and non-owner access', async () => {
    const db = new RecordingDb();
    db.rows.push({
      ...db.rows[0], id: 'child-other', start_ms: 3_000, end_ms: 3_500, split_parent_id: 'someone-else',
    });
    const repository = new SegmentRepository(db);

    await expect((repository as any).restoreSplit('project-1', 's1', 'child-other', 'dev-user', {
      startMs: 1_000, endMs: 3_000, sourceText: 'x', translatedText: 'y', speakerId: 'speaker-1',
    })).rejects.toMatchObject({ code: 'SPLIT_LINEAGE_MISMATCH' });

    await expect((repository as any).splitSegment('project-1', 's1', 'other-user', 2_000))
      .rejects.toMatchObject({ code: 'SEGMENT_NOT_FOUND' });
    expect(db.batches).toHaveLength(0);
  });
});
