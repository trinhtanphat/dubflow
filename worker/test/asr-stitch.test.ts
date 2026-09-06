import { describe, expect, it } from 'vitest';
import type { AsrSegment } from '../src/services/asr/types';
import { stitchAsrChunks, type StitchChunk } from '../src/services/asr/stitch';

function chunk(
  projectId: string,
  chunkId: string,
  chunkOrder: number,
  offsetMs: number,
  overlapBeforeMs: number,
  overlapAfterMs: number,
  segments: AsrSegment[],
): StitchChunk {
  return { projectId, chunkId, chunkOrder, offsetMs, overlapBeforeMs, overlapAfterMs, segments };
}

describe('ASR overlap stitching', () => {
  it('dedupes one overlap utterance and keeps the same speaker when the local index changes', () => {
    const result = stitchAsrChunks([
      chunk('p1', 'c0', 0, 0, 0, 15_000, [
        { startMs: 270_000, endMs: 272_000, text: 'before', speakerIndex: 0 },
        { startMs: 290_000, endMs: 295_000, text: 'Hello!', speakerIndex: 0 },
      ]),
      chunk('p1', 'c1', 1, 285_000, 15_000, 15_000, [
        { startMs: 5_000, endMs: 10_000, text: 'hello', speakerIndex: 2 },
        { startMs: 20_000, endMs: 22_000, text: 'after', speakerIndex: 2 },
      ]),
    ]);

    expect(result.map((segment) => segment.text)).toEqual(['before', 'Hello!', 'after']);
    expect(new Set(result.map((segment) => segment.speakerId))).toHaveLength(1);
    expect(result[0].speakerId).toMatch(/^spk_[0-9a-f]{8}$/);
  });

  it('keeps two independently matched speakers as two project speakers', () => {
    const result = stitchAsrChunks([
      chunk('p1', 'left', 0, 0, 0, 15_000, [
        { startMs: 290_000, endMs: 292_000, text: 'alpha', speakerIndex: 0 },
        { startMs: 293_000, endMs: 295_000, text: 'beta', speakerIndex: 1 },
      ]),
      chunk('p1', 'right', 1, 285_000, 15_000, 0, [
        { startMs: 5_000, endMs: 7_000, text: 'alpha', speakerIndex: 7 },
        { startMs: 8_000, endMs: 10_000, text: 'beta', speakerIndex: 8 },
      ]),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].speakerId).not.toBe(result[1].speakerId);
  });

  it('does not merge a tied local speaker candidate', () => {
    const result = stitchAsrChunks([
      chunk('p1', 'left', 0, 0, 0, 15_000, [
        { startMs: 289_000, endMs: 291_000, text: 'same one', speakerIndex: 0 },
        { startMs: 293_000, endMs: 295_000, text: 'same two', speakerIndex: 0 },
      ]),
      chunk('p1', 'right', 1, 285_000, 15_000, 0, [
        { startMs: 4_000, endMs: 6_000, text: 'same one', speakerIndex: 1 },
        { startMs: 8_000, endMs: 10_000, text: 'same two', speakerIndex: 2 },
        { startMs: 20_000, endMs: 21_000, text: 'speaker one later', speakerIndex: 1 },
        { startMs: 22_000, endMs: 23_000, text: 'speaker two later', speakerIndex: 2 },
      ]),
    ]);

    const later = result.filter((segment) => segment.text.includes('later'));
    expect(later).toHaveLength(2);
    expect(later[0].speakerId).not.toBe(later[1].speakerId);
    expect(later[0].speakerId).not.toBe(result[0].speakerId);
    expect(later[1].speakerId).not.toBe(result[0].speakerId);
  });

  it('does not merge speakers when adjacent chunks share no duplicate speech', () => {
    const result = stitchAsrChunks([
      chunk('p1', 'left', 0, 0, 0, 15_000, [
        { startMs: 290_000, endMs: 292_000, text: 'left only', speakerIndex: 0 },
      ]),
      chunk('p1', 'right', 1, 285_000, 15_000, 0, [
        { startMs: 5_000, endMs: 7_000, text: 'right only', speakerIndex: 0 },
      ]),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].speakerId).not.toBe(result[1].speakerId);
  });

  it('does not treat punctuation-only text as stitching evidence', () => {
    const result = stitchAsrChunks([
      chunk('p1', 'left', 0, 0, 0, 15_000, [
        { startMs: 290_000, endMs: 292_000, text: '!!!', speakerIndex: 0 },
      ]),
      chunk('p1', 'right', 1, 285_000, 15_000, 0, [
        { startMs: 5_000, endMs: 7_000, text: '???', speakerIndex: 1 },
      ]),
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].speakerId).not.toBe(result[1].speakerId);
  });

  it('is deterministic when chunk input order is reversed', () => {
    const chunks = [
      chunk('p1', 'left', 0, 0, 0, 15_000, [
        { startMs: 290_000, endMs: 295_000, text: 'shared', speakerIndex: 0 },
      ]),
      chunk('p1', 'right', 1, 285_000, 15_000, 0, [
        { startMs: 5_000, endMs: 10_000, text: 'shared', speakerIndex: 3 },
        { startMs: 20_000, endMs: 21_000, text: 'later', speakerIndex: 3 },
      ]),
    ];

    expect(stitchAsrChunks(chunks)).toEqual(stitchAsrChunks([...chunks].reverse()));
  });

  it('keeps undiarized segments unassigned', () => {
    const result = stitchAsrChunks([
      chunk('p1', 'single', 0, 0, 0, 0, [
        { startMs: 100, endMs: 900, text: 'plain transcript' },
      ]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].speakerId).toBeNull();
  });
});
