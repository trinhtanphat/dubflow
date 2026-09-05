import { describe, expect, it } from 'vitest';
import type { Segment } from './types';
import {
  MIN_SEGMENT_MS,
  clampMoveTiming,
  clampResizeTiming,
  snapEdgeTime,
  splitSegmentDraft,
  splitTextAtRatio,
} from './editing';

const neighbors = { previousEndMs: 500, nextStartMs: 2400 };

describe('segment timing editing', () => {
  it('moves a segment while preserving duration and clamping to neighbors', () => {
    expect(clampMoveTiming(
      { startMs: 1000, endMs: 2000 },
      700,
      neighbors,
      5000,
    )).toEqual({ startMs: 1400, endMs: 2400 });

    expect(clampMoveTiming(
      { startMs: 1000, endMs: 2000 },
      -900,
      neighbors,
      5000,
    )).toEqual({ startMs: 500, endMs: 1500 });
  });

  it('clamps moves to project bounds when there are no adjacent segments', () => {
    expect(clampMoveTiming(
      { startMs: 1000, endMs: 2000 },
      -5000,
      { previousEndMs: 0, nextStartMs: 5000 },
      5000,
    )).toEqual({ startMs: 0, endMs: 1000 });

    expect(clampMoveTiming(
      { startMs: 1000, endMs: 2000 },
      9000,
      { previousEndMs: 0, nextStartMs: 5000 },
      5000,
    )).toEqual({ startMs: 4000, endMs: 5000 });
  });

  it('resizes either edge without crossing neighbors or the minimum duration', () => {
    expect(MIN_SEGMENT_MS).toBe(100);
    expect(clampResizeTiming(
      { startMs: 1000, endMs: 2000 },
      'left',
      1950,
      neighbors,
      5000,
    )).toEqual({ startMs: 1900, endMs: 2000 });

    expect(clampResizeTiming(
      { startMs: 1000, endMs: 2000 },
      'right',
      2600,
      neighbors,
      5000,
    )).toEqual({ startMs: 1000, endMs: 2400 });
  });

  it('snaps within 8px and uses neighbor > playhead > grid when tied', () => {
    expect(snapEdgeTime(1000, [
      { timeMs: 1060, kind: 'grid' },
      { timeMs: 1060, kind: 'playhead' },
      { timeMs: 940, kind: 'neighbor' },
    ], 100)).toBe(940);

    expect(snapEdgeTime(1000, [
      { timeMs: 1080, kind: 'grid' },
    ], 100)).toBe(1080);

    expect(snapEdgeTime(1000, [
      { timeMs: 1090, kind: 'neighbor' },
    ], 100)).toBe(1000);
  });
});

describe('segment split drafting', () => {
  const segment: Segment = {
    id: 'seg-1',
    speakerId: 'speaker-1',
    startMs: 1000,
    endMs: 3000,
    sourceText: 'hello beautiful world',
    translatedText: 'xin chao the gioi',
  };

  it('splits text near the proportional whitespace boundary', () => {
    expect(splitTextAtRatio('hello beautiful world', 0.5)).toEqual({
      left: 'hello beautiful',
      right: 'world',
    });
  });

  it('falls back to Unicode code-point boundaries without duplicating text', () => {
    const result = splitTextAtRatio('你好世界', 0.5);
    expect(result).toEqual({ left: '你好', right: '世界' });
    expect(result.left + result.right).toBe('你好世界');
  });

  it('creates two children only when both sides meet the minimum duration', () => {
    const draft = splitSegmentDraft(segment, 2000);
    expect(draft.left).toMatchObject({ id: 'seg-1', startMs: 1000, endMs: 2000, speakerId: 'speaker-1' });
    expect(draft.right).toMatchObject({ startMs: 2000, endMs: 3000, speakerId: 'speaker-1' });
    expect(draft.left.sourceText).toBe('hello beautiful');
    expect(draft.right.sourceText).toBe('world');

    expect(() => splitSegmentDraft(segment, 1050)).toThrow(/100 ms/i);
    expect(() => splitSegmentDraft(segment, 2950)).toThrow(/100 ms/i);
  });
});
