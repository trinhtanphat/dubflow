export const MIN_PIXELS_PER_SECOND = 0.25;
export const MAX_PIXELS_PER_SECOND = 240;
const RULER_INTERVAL_SECONDS = [1, 2, 5, 10, 30, 60, 300, 600] as const;

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

export function clampPixelsPerSecond(value: number): number {
  return clamp(value, MIN_PIXELS_PER_SECOND, MAX_PIXELS_PER_SECOND);
}

export function timeToPixels(timeMs: number, pixelsPerSecond: number): number {
  const safeTimeMs = Number.isFinite(timeMs) ? Math.max(0, timeMs) : 0;
  const zoom = clampPixelsPerSecond(pixelsPerSecond);
  return safeTimeMs / 1000 * zoom;
}

export function pixelsToTime(px: number, pixelsPerSecond: number): number {
  const safePx = Number.isFinite(px) ? Math.max(0, px) : 0;
  const zoom = clampPixelsPerSecond(pixelsPerSecond);
  return safePx / zoom * 1000;
}

export function projectWidthPx(durationMs: number, pixelsPerSecond: number): number {
  return timeToPixels(durationMs, pixelsPerSecond);
}

export function fitPixelsPerSecond(durationMs: number, viewportWidth: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0 || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
    return MIN_PIXELS_PER_SECOND;
  }
  return clampPixelsPerSecond(viewportWidth / (durationMs / 1000));
}

export function pointerXToTime(
  pointerClientX: number,
  viewportLeft: number,
  scrollLeft: number,
  pixelsPerSecond: number,
): number {
  const pointer = Number.isFinite(pointerClientX) ? pointerClientX : 0;
  const left = Number.isFinite(viewportLeft) ? viewportLeft : 0;
  const scroll = Number.isFinite(scrollLeft) ? Math.max(0, scrollLeft) : 0;
  return pixelsToTime(Math.max(0, pointer - left + scroll), pixelsPerSecond);
}

export function chooseRulerIntervalSeconds(pixelsPerSecond: number): number {
  const zoom = clampPixelsPerSecond(pixelsPerSecond);
  return RULER_INTERVAL_SECONDS.find((seconds) => seconds * zoom >= 80)
    ?? RULER_INTERVAL_SECONDS[RULER_INTERVAL_SECONDS.length - 1];
}
