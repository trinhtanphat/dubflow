import { describe, expect, it } from 'vitest';
import { clamp, timeToPercent } from './math';

describe('timeline math', () => {
  it('clamps values and maps time into percentages', () => {
    expect(clamp(-1, 0, 100)).toBe(0);
    expect(clamp(101, 0, 100)).toBe(100);
    expect(timeToPercent(5_000, 10_000)).toBe(50);
    expect(timeToPercent(-1, 10_000)).toBe(0);
    expect(timeToPercent(11_000, 10_000)).toBe(100);
    expect(timeToPercent(1_000, 0)).toBe(0);
  });
});
