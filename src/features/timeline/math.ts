export function clamp(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function timeToPercent(timeMs: number, durationMs: number) {
  if (durationMs <= 0) return 0;
  return clamp(timeMs / durationMs, 0, 1) * 100;
}
