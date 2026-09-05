import { describe, expect, it } from 'vitest';
import {
  MAX_PIXELS_PER_SECOND,
  MIN_PIXELS_PER_SECOND,
  chooseRulerIntervalSeconds,
  clamp,
  clampPixelsPerSecond,
  fitPixelsPerSecond,
  pixelsToTime,
  pointerXToTime,
  projectWidthPx,
  timeToPercent,
  timeToPixels,
} from './math';

describe('timeline math', () => {
  it('clamps values and maps time into percentages', () => {
    expect(clamp(-1, 0, 100)).toBe(0);
    expect(clamp(101, 0, 100)).toBe(100);
    expect(timeToPercent(5_000, 10_000)).toBe(50);
    expect(timeToPercent(-1, 10_000)).toBe(0);
    expect(timeToPercent(11_000, 10_000)).toBe(100);
    expect(timeToPercent(1_000, 0)).toBe(0);
  });

  it('maps timeline time and pixels at a bounded zoom level', () => {
    expect(timeToPixels(2000, 50)).toBe(100);
    expect(pixelsToTime(125, 50)).toBe(2500);
    expect(clampPixelsPerSecond(0)).toBe(MIN_PIXELS_PER_SECOND);
    expect(clampPixelsPerSecond(1000)).toBe(MAX_PIXELS_PER_SECOND);
    expect(projectWidthPx(10_000, 50)).toBe(500);
    expect(fitPixelsPerSecond(10_000, 500)).toBe(50);
  });

  it('maps a viewport pointer into project time including horizontal scroll', () => {
    expect(pointerXToTime(250, 100, 50, 50)).toBe(4000);
    expect(pointerXToTime(50, 100, 0, 50)).toBe(0);
  });

  it('chooses a bounded major-ruler interval that keeps labels readable', () => {
    expect(chooseRulerIntervalSeconds(240)).toBe(1);
    expect(chooseRulerIntervalSeconds(50)).toBe(2);
    expect(chooseRulerIntervalSeconds(1)).toBe(300);
    expect(chooseRulerIntervalSeconds(0.25)).toBe(600);
  });
});
