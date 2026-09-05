import { describe, expect, it } from 'vitest';
import { normalizeSegmentPatch } from '../src/domain/segment';

describe('segment patch validation', () => {
  it('accepts editable text, speaker, and timing fields', () => {
    expect(normalizeSegmentPatch({
      sourceText: ' nguồn ', translatedText: ' dịch ', speakerId: 'speaker-2', startMs: 100, endMs: 900,
    }, { startMs: 0, endMs: 1000 })).toEqual({
      sourceText: ' nguồn ', translatedText: ' dịch ', speakerId: 'speaker-2', startMs: 100, endMs: 900,
    });
  });

  it('rejects immutable/unknown identity fields', () => {
    expect(() => normalizeSegmentPatch({ id: 'other' } as any, { startMs: 0, endMs: 1000 })).toThrow();
    expect(() => normalizeSegmentPatch({ projectId: 'other' } as any, { startMs: 0, endMs: 1000 })).toThrow();
  });

  it('requires endMs greater than startMs after merging patch with current timing', () => {
    expect(() => normalizeSegmentPatch({ startMs: 1000 }, { startMs: 0, endMs: 1000 })).toThrow();
    expect(() => normalizeSegmentPatch({ endMs: 0 }, { startMs: 0, endMs: 1000 })).toThrow();
  });
});
