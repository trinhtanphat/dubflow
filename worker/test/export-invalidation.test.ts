import { describe, expect, it } from 'vitest';
import { SegmentRepository } from '../src/db/segments';

type Call = { sql: string; values: unknown[] };

function statefulDb() {
  const calls: Call[] = [];
  const segmentRow = {
    id: 's1', project_id: 'p1', speaker_id: 'speaker-1', start_ms: 1000, end_ms: 3000,
    source_text: 'nguon', translated_text: 'cu', translation_engine: 'workers-ai', translation_status: 'completed',
    translation_context_revision: 1,
    voice_status: 'completed', dubbed_object_key: 'projects/p1/dubbed/s1.mp3', version: 2, split_parent_id: null,
  };
  const translationRows = [
    {
      segment_id: 's1', project_id: 'p1', target_language: 'vi', translated_text: 'cu',
      translation_engine: 'workers-ai', translation_status: 'completed', translation_context_revision: 1,
      voice_status: 'completed', dubbed_object_key: 'projects/p1/voices/vi/s1/2.mp3', version: 2,
    },
    {
      segment_id: 's1', project_id: 'p1', target_language: 'ja', translated_text: '古い',
      translation_engine: 'workers-ai', translation_status: 'completed', translation_context_revision: 1,
      voice_status: 'completed', dubbed_object_key: 'projects/p1/voices/ja/s1/2.mp3', version: 2,
    },
  ];
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async run() { calls.push({ sql, values }); return { meta: { changes: 1 } }; },
        async all<T>() {
          if (/FROM segment_translations/i.test(sql)) return { results: translationRows as T[] };
          return { results: [segmentRow] as T[] };
        },
        async first<T>() {
          if (sql.includes('FROM segments s JOIN projects p')) return segmentRow as T;
          if (sql.includes('SELECT id, duration_ms, status FROM projects')) {
            return { id: 'p1', duration_ms: 10_000, status: 'needs_review' } as T;
          }
          if (/SELECT id FROM projects/i.test(sql)) return { id: 'p1' } as T;
          return null as T | null;
        },
      };
    },
    async batch(statements: any[]) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return { db: db as any, calls };
}

describe('final export invalidation', () => {
  it('invalidates a published export when translated text changes using the canonical revision', async () => {
    const { db, calls } = statefulDb();
    const repo = new SegmentRepository(db);

    await repo.setTranslationResult('p1', 's1', 'dev-user', 2, 'moi', 'workers-ai');

    expect(calls.some((call) => /UPDATE projects/i.test(call.sql)
      && /export_object_key\s*=\s*NULL/i.test(call.sql)
      && /status\s*=\s*'needs_review'/i.test(call.sql))).toBe(true);
  });

  it('invalidates a published export when segment timing changes using the canonical revision', async () => {
    const { db, calls } = statefulDb();
    const repo = new SegmentRepository(db);

    await repo.updateSegment('p1', 's1', 'dev-user', 2, { startMs: 1200, endMs: 3200 });

    expect(calls.some((call) => /UPDATE projects/i.test(call.sql)
      && /export_object_key\s*=\s*NULL/i.test(call.sql)
      && /status\s*=\s*'needs_review'/i.test(call.sql))).toBe(true);
  });

  it('source edits invalidate every translation variant and every target export attempt', async () => {
    const { db, calls } = statefulDb();
    const repo = new SegmentRepository(db);

    await repo.updateSegment('p1', 's1', 'dev-user', 2, { sourceText: 'nguon moi' });

    expect(calls.some((call) => /UPDATE segment_translations/i.test(call.sql)
      && /translation_status\s*=\s*'pending'/i.test(call.sql)
      && /voice_status\s*=\s*'pending'/i.test(call.sql)
      && /dubbed_object_key\s*=\s*NULL/i.test(call.sql))).toBe(true);
    expect(calls.some((call) => /UPDATE project_exports/i.test(call.sql)
      && /status\s*=\s*'invalidated'/i.test(call.sql)
      && !/target_language\s*=\s*\?/i.test(call.sql))).toBe(true);
  });

  it('timing edits invalidate dubbed attempts without resetting target translations', async () => {
    const { db, calls } = statefulDb();
    const repo = new SegmentRepository(db);

    await repo.updateSegment('p1', 's1', 'dev-user', 2, { startMs: 1200, endMs: 3200 });

    expect(calls.some((call) => /UPDATE project_exports/i.test(call.sql)
      && /status\s*=\s*'invalidated'/i.test(call.sql)
      && /output\s*=\s*'dubbed'/i.test(call.sql))).toBe(true);
    expect(calls.some((call) => /UPDATE segment_translations/i.test(call.sql)
      && /translation_status\s*=\s*'pending'/i.test(call.sql))).toBe(false);
  });

  it('legacy Vietnamese translation results synchronize the Vietnamese variant', async () => {
    const { db, calls } = statefulDb();
    const repo = new SegmentRepository(db);

    await repo.setTranslationResult('p1', 's1', 'dev-user', 2, 'moi', 'workers-ai', 3);

    expect(calls.some((call) => /segment_translations/i.test(call.sql)
      && /target_language/i.test(call.sql)
      && call.values.includes('vi')
      && call.values.includes('moi'))).toBe(true);
  });

  it('split synchronizes existing target-language variants for both child segments', async () => {
    const { db, calls } = statefulDb();
    const repo = new SegmentRepository(db);

    await repo.splitSegment('p1', 's1', 'dev-user', 2, 2000);

    expect(calls.some((call) => /UPDATE segment_translations/i.test(call.sql))).toBe(true);
    expect(calls.some((call) => /INSERT INTO segment_translations/i.test(call.sql))).toBe(true);
  });
});
