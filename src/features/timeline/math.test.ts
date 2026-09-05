import { describe, expect, it } from 'vitest';
import { clamp, timeToPercent } from './math';

describe('timeline math', () => {
  it('converts time to a percentage', () => {
    expect(timeToPercent(2500, 10000)).toBe(25);
  });

  it('clamps geometry to the track bounds', () => {
    expect(clamp(-1)).toBe(0);
    expect(clamp(2)).toBe(1);
    expect(timeToPercent(20000, 10000)).toBe(100);
  });
});
