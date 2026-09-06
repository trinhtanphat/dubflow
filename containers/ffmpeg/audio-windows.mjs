export function buildAudioWindows(durationMs, chunkSeconds, overlapSeconds) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error('durationMs must be a positive finite number.');
  }
  if (!Number.isInteger(chunkSeconds) || chunkSeconds < 30 || chunkSeconds > 600) {
    throw new Error('chunkSeconds must be an integer between 30 and 600.');
  }
  if (
    !Number.isInteger(overlapSeconds) ||
    overlapSeconds < 0 ||
    overlapSeconds > 30 ||
    overlapSeconds >= chunkSeconds
  ) {
    throw new Error('overlapSeconds must be an integer from 0 through 30 and less than chunkSeconds.');
  }

  const chunkMs = chunkSeconds * 1000;
  const strideMs = (chunkSeconds - overlapSeconds) * 1000;
  const windows = [];
  for (let offsetMs = 0; offsetMs < durationMs; offsetMs += strideMs) {
    windows.push({
      offsetMs,
      durationMs: Math.min(chunkMs, durationMs - offsetMs),
    });
  }
  return windows;
}
