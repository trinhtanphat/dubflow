import { describe, expect, it } from 'vitest';
import { buildAudioWindows } from './audio-windows.mjs';

describe('FFmpeg ASR analysis windows', () => {
  it('builds bounded 300-second windows with an 8-second overlap', () => {
    expect(buildAudioWindows(610_000, 300, 8)).toEqual([
      { offsetMs: 0, durationMs: 300_000 },
      { offsetMs: 292_000, durationMs: 300_000 },
      { offsetMs: 584_000, durationMs: 26_000 },
    ]);
  });

  it.each([-1, 31, 300])('rejects invalid overlap %s', (overlapSeconds) => {
    expect(() => buildAudioWindows(610_000, 300, overlapSeconds)).toThrow(/overlapSeconds/);
  });

  it('rejects invalid chunk duration and source duration', () => {
    expect(() => buildAudioWindows(610_000, 29, 8)).toThrow(/chunkSeconds/);
    expect(() => buildAudioWindows(0, 300, 8)).toThrow(/duration/);
  });
});
