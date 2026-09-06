import { describe, expect, it } from 'vitest';
import { formatSrtTime, serializeSrt } from '../src/services/subtitles/srt';

describe('Phase 4C deterministic subtitle export', () => {
  it('formats canonical SRT timestamps including hour rollover and milliseconds', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(3_723_004)).toBe('01:02:03,004');
  });

  it('serializes deterministic Unicode SRT while normalizing text line endings only', () => {
    expect(serializeSrt([
      { index: 1, startMs: 0, endMs: 1_250, text: 'こんにちは\r\n世界' },
      { index: 2, startMs: 1_250, endMs: 2_500, text: '再见' },
    ])).toBe(
      '1\n00:00:00,000 --> 00:00:01,250\nこんにちは\n世界\n\n' +
      '2\n00:00:01,250 --> 00:00:02,500\n再见\n',
    );
  });

  it('rejects negative and non-finite subtitle timestamps', () => {
    expect(() => formatSrtTime(-1)).toThrow(/timestamp|time|negative/i);
    expect(() => formatSrtTime(Number.NaN)).toThrow(/timestamp|time|finite/i);
    expect(() => formatSrtTime(Number.POSITIVE_INFINITY)).toThrow(/timestamp|time|finite/i);
  });
});
