import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioChunkWindows } from './audio-chunks.mjs';

test('uses 300s windows with 15s overlap', () => {
  const windows = buildAudioChunkWindows(900_000);
  assert.deepEqual(windows.map((window) => window.offsetMs), [0, 285_000, 570_000, 855_000]);
  assert.deepEqual(windows.map((window) => [window.overlapBeforeMs, window.overlapAfterMs]), [
    [0, 15_000],
    [15_000, 15_000],
    [15_000, 15_000],
    [15_000, 0],
  ]);
});

test('keeps one short source window without synthetic overlap', () => {
  assert.deepEqual(buildAudioChunkWindows(12_000), [{
    offsetMs: 0,
    durationMs: 12_000,
    overlapBeforeMs: 0,
    overlapAfterMs: 0,
  }]);
});

test('rejects overlap greater than or equal to chunk length', () => {
  assert.throws(() => buildAudioChunkWindows(60_000, 30_000, 30_000));
});
