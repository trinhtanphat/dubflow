import { describe, expect, it } from 'vitest';
import type { D1DatabaseLike, D1StatementLike } from '../src/db/projects';
import { SegmentRepository } from '../src/db/segments';
import { normalizeAsrSegments, SegmentInputError } from '../src/domain/segment';

class Statement implements D1StatementLike {
  values: unknown[] = [];
  constructor(public readonly db: RecordingDb, public readonly sql: string) {}
  bind(...values: unknown[]) { this.values = values; return this; }
  async run() { return {}; }
  async all<T>() {
    if (!this.sql.includes('FROM segments s')) return { results: [] as T[] };
    const [projectId, userId] = this.values as [string, string];
    if (projectId !== 'project-1' || userId !== 'dev-user') return { results: [] as T[] };
    return { results: this.db.rows.map((row) => ({ ...row })) as T[] };
  }
  async first<T>() {
    if (this.sql.includes('FROM projects') && this.values[0] === 'project-1' && this.values[1] === 'dev-user') {
      return { id: 'project-1' } as T;
    }
    return null;
  }
}

class RecordingDb implements D1DatabaseLike {
  rows: Array<Record<string, unknown>> = [
    {
      id: 'stale', project_id: 'project-1', speaker_id: null, start_ms: 0, end_ms: 10,
      source_text: 'stale', translated_text: 'stale', translation_engine: 'workers-ai',
      translation_status: 'completed', voice_status: 'pending', version: 3,
    },
  ];
  batches: Statement[][] = [];

  prepare(sql: string) { return new Statement(this, sql); }

  async batch(statements: D1StatementLike[]) {
    const typed = statements as Statement[];
    this.batches.push(typed);
    this.rows = [];
    for (const statement of typed) {
      if (!statement.sql.startsWith('INSERT INTO segments')) continue;
      const values = statement.values;
      const [id, projectId] = values;
      const speakerAware = values.length >= 6;
      const speakerId = speakerAware ? values[2] : null;
      const startMs = values[speakerAware ? 3 : 2];
      const endMs = values[speakerAware ? 4 : 3];
      const sourceText = values[speakerAware ? 5 : 4];
      this.rows.push({
        id, project_id: projectId, speaker_id: speakerId, start_ms: startMs, end_ms: endMs,
        source_text: sourceText, translated_text: '', translation_engine: 'workers-ai',
        translation_status: 'pending', voice_status: 'pending', version: 1,
      });
    }
    return [];
  }
}

describe('ASR segment persistence', () => {
  it('validates IDs and timestamp ranges before touching D1', () => {
    expect(() => normalizeAsrSegments([
      { id: 'a', startMs: 0, endMs: 1000, sourceText: 'one' },
      { id: 'a', startMs: 1000, endMs: 2000, sourceText: 'two' },
    ])).toThrowError(SegmentInputError);

    expect(() => normalizeAsrSegments([
      { id: 'a', startMs: 1000, endMs: 1000, sourceText: 'bad' },
    ])).toThrowError(SegmentInputError);
  });

  it('atomically replaces stale rows and returns deterministic start/id ordering', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    const segments = await repository.replaceFromAsr('project-1', 'dev-user', [
      { id: 'b', startMs: 2000, endMs: 3000, sourceText: 'second' },
      { id: 'a', startMs: 0, endMs: 1000, sourceText: 'first' },
    ]);

    expect(db.batches).toHaveLength(1);
    expect(db.batches[0][0].sql).toContain('DELETE FROM segments');
    expect(db.rows.some((row) => row.id === 'stale')).toBe(false);
    expect(segments.map((segment) => segment.id)).toEqual(['a', 'b']);
    expect(segments[0]).toMatchObject({
      translatedText: '', translationStatus: 'pending', voiceStatus: 'pending', version: 1,
    });
  });

  it('upserts detected speaker rows before persisting diarized segment foreign keys', async () => {
    const db = new RecordingDb();
    const repository = new SegmentRepository(db);

    const segments = await repository.replaceFromAsr('project-1', 'dev-user', [
      { id: 'a', speakerId: 'spk_1234abcd', startMs: 0, endMs: 1000, sourceText: 'first' },
    ]);

    const batch = db.batches[0];
    const speakerInsert = batch.find((statement) => /INSERT INTO speakers/i.test(statement.sql));
    const segmentInsert = batch.find((statement) => /INSERT INTO segments/i.test(statement.sql));
    expect(speakerInsert?.values.slice(0, 2)).toEqual(['spk_1234abcd', 'project-1']);
    expect(segmentInsert?.values.slice(0, 3)).toEqual(['a', 'project-1', 'spk_1234abcd']);
    expect(segments[0]).toMatchObject({ speakerId: 'spk_1234abcd' });
  });

  it('rejects writes to a project outside the current user', async () => {
    const repository = new SegmentRepository(new RecordingDb());
    await expect(repository.replaceFromAsr('project-1', 'other-user', [
      { id: 'a', startMs: 0, endMs: 1000, sourceText: 'first' },
    ])).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });
  });
});
