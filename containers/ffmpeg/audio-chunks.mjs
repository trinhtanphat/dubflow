export const AUDIO_CHUNK_MS = 300_000;
export const AUDIO_CHUNK_OVERLAP_MS = 15_000;

export function buildAudioChunkWindows(
  durationMs,
  chunkMs = AUDIO_CHUNK_MS,
  overlapMs = AUDIO_CHUNK_OVERLAP_MS,
) {
  if (!Number.isInteger(durationMs) || durationMs <= 0) {
    throw new Error('durationMs must be a positive integer.');
  }
  if (!Number.isInteger(chunkMs) || chunkMs <= 0) {
    throw new Error('chunkMs must be a positive integer.');
  }
  if (!Number.isInteger(overlapMs) || overlapMs < 0 || overlapMs >= chunkMs) {
    throw new Error('overlapMs must be a non-negative integer smaller than chunkMs.');
  }

  const stepMs = chunkMs - overlapMs;
  const windows = [];
  let offsetMs = 0;
  while (offsetMs < durationMs) {
    const windowDurationMs = Math.min(chunkMs, durationMs - offsetMs);
    const hasNext = offsetMs + chunkMs < durationMs;
    windows.push({
      offsetMs,
      durationMs: windowDurationMs,
      overlapBeforeMs: windows.length === 0 ? 0 : Math.min(overlapMs, windowDurationMs),
      overlapAfterMs: hasNext ? Math.min(overlapMs, windowDurationMs) : 0,
    });
    if (!hasNext) break;
    offsetMs += stepMs;
  }
  return windows;
}
