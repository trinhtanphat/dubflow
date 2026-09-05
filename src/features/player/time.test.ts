import { describe, expect, it } from 'vitest';
import { formatTimestamp } from './time';

describe('formatTimestamp', () => {
  it('formats minute timestamps', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp((15 * 60 + 23) * 1000)).toBe('15:23');
  });

  it('formats hour timestamps', () => {
    expect(formatTimestamp((60 * 60 + 2 * 60 + 3) * 1000)).toBe('1:02:03');
  });
});
