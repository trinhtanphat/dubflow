import { describe, expect, it, vi } from 'vitest';
import { SegmentRepository } from '../src/db/segments';
import { SpeakerRepository } from '../src/db/speakers';

function segmentDb() {
  const segmentRow = {
    id: 's1', project_id: 'p1', speaker_id: 'speaker-1', start_ms: 1000, end_ms: 3000,
    source_text: 'source', translated_text: 'old', translation_engine: 'workers-ai', translation_context_revision: 1,
    translation_status: 'completed', voice_status: 'completed', dubbed_object_key: 'projects/p1/dubbed/s1.mp3',
    version: 2, split_parent_id: null,
  };
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async run() { return { meta: { changes: 1 } }; },
        async all<T>() { return { results: [segmentRow] as T[] }; },
        async first<T>() {
          if (/FROM segments s JOIN projects p/i.test(sql)) return segmentRow as T;
          if (/SELECT id, duration_ms, status FROM projects/i.test(sql)) {
            return { id: 'p1', duration_ms: 10_000, status: 'needs_review' } as T;
          }
          return null as T | null;
        },
      };
    },
    async batch(statements: any[]) { for (const statement of statements) await statement.run(); return []; },
  } as any;
}

function speakerDb() {
  const speakerRow = {
    id: 'speaker-1', project_id: 'p1', label: 'SPEAKER_00', display_name: 'Speaker 1',
    voice_provider: null, voice_id: null, avatar_object_key: null,
  };
  return {
    prepare(sql: string) {
      return {
        bind() { return this; },
        async run() { return { meta: { changes: 1 } }; },
        async all<T>() { return { results: [speakerRow] as T[] }; },
        async first<T>() {
          if (/FROM speakers s JOIN projects p/i.test(sql)) return speakerRow as T;
          if (/SELECT id, status FROM projects/i.test(sql)) return { id: 'p1', status: 'needs_review' } as T;
          return null as T | null;
        },
      };
    },
    async batch(statements: any[]) { for (const statement of statements) await statement.run(); return []; },
  } as any;
}

describe('Phase 4C mutation invalidation matrix', () => {
  it('invalidates every target translation/dub/export after a source or timing mutation', async () => {
    const multilang = { invalidateSegmentAllTargets: vi.fn(async () => {}) };
    const repo = new (SegmentRepository as any)(segmentDb(), multilang);

    await repo.updateSegment('p1', 's1', 'dev-user', 2, { sourceText: 'changed source', startMs: 1200, endMs: 3200 });

    expect(multilang.invalidateSegmentAllTargets).toHaveBeenCalledWith('p1', 's1', 'dev-user');
  });

  it('invalidates only Vietnamese target dub/export after the legacy Vietnamese translation changes', async () => {
    const multilang = { invalidateSegmentTarget: vi.fn(async () => {}) };
    const repo = new (SegmentRepository as any)(segmentDb(), multilang);

    await repo.setTranslationResult('p1', 's1', 'dev-user', 2, 'new vi', 'workers-ai', 1);

    expect(multilang.invalidateSegmentTarget).toHaveBeenCalledWith('p1', 's1', 'dev-user', 'vi');
  });

  it('invalidates the assigned speaker dubs and dependent exports across all targets on voice change only', async () => {
    const multilang = { invalidateSpeakerAllTargets: vi.fn(async () => {}) };
    const repo = new (SpeakerRepository as any)(speakerDb(), multilang);

    await repo.update('p1', 'speaker-1', 'dev-user', { voiceId: 'voice-1' });
    expect(multilang.invalidateSpeakerAllTargets).toHaveBeenCalledWith('p1', 'speaker-1', 'dev-user');

    multilang.invalidateSpeakerAllTargets.mockClear();
    await repo.update('p1', 'speaker-1', 'dev-user', { displayName: 'Renamed' });
    expect(multilang.invalidateSpeakerAllTargets).not.toHaveBeenCalled();
  });
});
