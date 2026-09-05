import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaFile, validateMediaDuration, MAX_MEDIA_BYTES, MAX_MEDIA_DURATION_SECONDS } from '../build/upload/mediaValidation.js';
import { formatTimestamp } from '../build/player/time.js';
import { clamp, timeToPercent } from '../build/timeline/math.js';

test('media validation accepts supported formats within 5 GB', () => {
  assert.equal(validateMediaFile({ name: 'episode.mp4', size: MAX_MEDIA_BYTES }).valid, true);
  assert.equal(validateMediaFile({ name: 'episode.webm', size: 1024 }).valid, true);
  assert.equal(validateMediaFile({ name: 'episode.mkv', size: 1024 }).valid, true);
  assert.equal(validateMediaFile({ name: 'episode.mov', size: 1024 }).valid, true);
});

test('media validation rejects unsupported format and file over 5 GB', () => {
  assert.equal(validateMediaFile({ name: 'episode.avi', size: 1024 }).valid, false);
  assert.equal(validateMediaFile({ name: 'episode.mp4', size: MAX_MEDIA_BYTES + 1 }).valid, false);
});

test('duration validation enforces 3 hour maximum', () => {
  assert.equal(validateMediaDuration(MAX_MEDIA_DURATION_SECONDS).valid, true);
  assert.equal(validateMediaDuration(MAX_MEDIA_DURATION_SECONDS + 0.001).valid, false);
});

test('formatTimestamp renders minute and hour forms', () => {
  assert.equal(formatTimestamp(0), '00:00');
  assert.equal(formatTimestamp(15 * 60 + 23), '15:23');
  assert.equal(formatTimestamp(1 * 3600 + 2 * 60 + 3), '1:02:03');
});

test('timeline math clamps values and converts time to percentage', () => {
  assert.equal(clamp(-1, 0, 100), 0);
  assert.equal(clamp(101, 0, 100), 100);
  assert.equal(timeToPercent(5_000, 10_000), 50);
  assert.equal(timeToPercent(-1, 10_000), 0);
  assert.equal(timeToPercent(11_000, 10_000), 100);
  assert.equal(timeToPercent(1_000, 0), 0);
});
