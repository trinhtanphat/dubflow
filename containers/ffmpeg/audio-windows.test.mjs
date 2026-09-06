import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioWindows } from './audio-windows.mjs';

test('builds bounded 300-second windows with an 8-second overlap', () => {
  assert.deepEqual(buildAudioWindows(610_000, 300, 8), [
    { offsetMs: 0, durationMs: 300_000 },
    { offsetMs: 292_000, durationMs: 300_000 },
    { offsetMs: 584_000, durationMs: 26_000 },
  ]);
});

test('does not emit an overlap-only tail when the first window already covers the source', () => {
  assert.deepEqual(buildAudioWindows(300_000, 300, 8), [
    { offsetMs: 0, durationMs: 300_000 },
  ]);
  assert.deepEqual(buildAudioWindows(295_000, 300, 8), [
    { offsetMs: 0, durationMs: 295_000 },
  ]);
});

for (const overlapSeconds of [-1, 31, 300]) {
  test(`rejects invalid overlap ${overlapSeconds}`, () => {
    assert.throws(() => buildAudioWindows(610_000, 300, overlapSeconds), /overlapSeconds/);
  });
}

test('rejects invalid chunk duration and source duration', () => {
  assert.throws(() => buildAudioWindows(610_000, 29, 8), /chunkSeconds/);
  assert.throws(() => buildAudioWindows(0, 300, 8), /duration/);
});
