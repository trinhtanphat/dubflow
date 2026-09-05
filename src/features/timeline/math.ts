export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError('min must be less than or equal to max');
  }
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

export function timeToPercent(timeMs: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  const safeTime = Number.isFinite(timeMs) ? timeMs : 0;
  return clamp((safeTime / durationMs) * 100, 0, 100);
}
