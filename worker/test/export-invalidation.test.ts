import { describe, expect, it } from 'vitest';
import { SegmentRepository } from '../src/db/segments';

type Call = { sql: string; values: unknown[] };

function statefulDb() {
  const calls: Call[] = [];
  const segmentRow = {
    id: 's1', project_id: 'p1', speaker_id: 'speaker-1', start_ms: 1000, end_ms: 3000,
    source_text: 'nguon', translated_text: 'cu', translation_engine: 'workers-ai', translation_status: 'completed',
    voice_status: 'completed', dubbed_object_key: 'projects/p1/dubbed/s1.mp3', version: 2, split_parent_id: null,
  };
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async run() { calls.push({ sql, values }); return {}; },
        async all<T>() { return { results: [segmentRow] as T[] }; },
        async first<T>() {
          if (sql.includes('FROM segments s JOIN projects p')) return segmentRow as T;
          if (sql.includes('SELECT id, duration_ms FROM projects')) return { id: 'p1', duration_ms: 10_000 } as T;
          return null as T | null;
        },
      };
    },
    async batch(statements: any[]) {
      for (const statement of statements) await statement.run();
      return [];
    },
  };
  return { db: db as any, calls };
}

describe('final export invalidation', () => {
  it('invalidates a published export when translated text changes', async () => {
    const { db, calls } = statefulDb();
    const repo = new SegmentRepository(db);

    await repo.setTranslationResult('p1', 's1', 'dev-user', 'moi', 'workers-ai');

    expect(calls.some((call) => /UPDATE projects/i.test(call.sql)
      && /export_object_key\s*=\s*NULL/i.test(call.sql)
      && /status\s*=\s*'needs_review'/i.test(call.sql))).toBe(true);
  });

  it('invalidates a published export when segment timing changes', async () => {
    const { db, calls } = statefulDb();
    const repo = new SegmentRepository(db);

    await repo.updateSegment('p1', 's1', 'dev-user', { startMs: 1200, endMs: 3200 });

    expect(calls.some((call) => /UPDATE projects/i.test(call.sql)
      && /export_object_key\s*=\s*NULL/i.test(call.sql)
      && /status\s*=\s*'needs_review'/i.test(call.sql))).toBe(true);
  });
});
