import { describe, expect, it } from 'vitest';
import { formatTimestamp } from './time';

describe('formatTimestamp', () => {
  it('formats minute and hour timestamps', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(15 * 60 + 23)).toBe('15:23');
    expect(formatTimestamp(3600 + 2 * 60 + 3)).toBe('1:02:03');
  });
});
