import { describe, expect, it } from 'vitest';
import { stitchAsrChunks } from '../src/services/asr/stitch';

describe('strong cross-chunk speaker evidence', () => {
  it('normalizes punctuation before duplicate matching and speaker stitching', () => {
    const stitched = stitchAsrChunks([
      {
        projectId: 'p1', chunkId: 'c1', offsetMs: 0,
        segments: [{ startMs: 294_000, endMs: 296_000, text: 'Hello!', speakerIndex: 0 }],
      },
      {
        projectId: 'p1', chunkId: 'c2', offsetMs: 292_000,
        segments: [
          { startMs: 2_000, endMs: 4_000, text: 'hello', speakerIndex: 3 },
          { startMs: 5_000, endMs: 6_000, text: 'later', speakerIndex: 3 },
        ],
      },
    ]);

    expect(stitched.map((segment) => segment.text)).toEqual(['Hello!', 'later']);
    expect(stitched[0].speakerId).toBe(stitched[1].speakerId);
  });

  it('deduplicates a short overlap utterance without using it to merge speaker identity', () => {
    const stitched = stitchAsrChunks([
      {
        projectId: 'p1', chunkId: 'c1', offsetMs: 0,
        segments: [{ startMs: 294_000, endMs: 294_600, text: 'tiny', speakerIndex: 0 }],
      },
      {
        projectId: 'p1', chunkId: 'c2', offsetMs: 292_000,
        segments: [
          { startMs: 2_000, endMs: 2_600, text: 'tiny', speakerIndex: 3 },
          { startMs: 5_000, endMs: 6_000, text: 'right tail', speakerIndex: 3 },
        ],
      },
    ]);

    expect(stitched.map((segment) => segment.text)).toEqual(['tiny', 'right tail']);
    expect(stitched[0].speakerId).toBeTruthy();
    expect(stitched[1].speakerId).toBeTruthy();
    expect(stitched[0].speakerId).not.toBe(stitched[1].speakerId);
  });
});
