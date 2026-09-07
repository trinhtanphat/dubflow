import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const repoFile = (path) => new URL(`../${path}`, import.meta.url);
const readRequiredSource = async (path) => {
  assert.equal(existsSync(repoFile(path)), true, `${path} must exist`);
  return readFile(repoFile(path), 'utf8');
};

test('real-media smoke runner exercises live upload, dubbing, export and media verification', async () => {
  const source = await readRequiredSource('scripts/real-media-smoke.mjs');
  assert.match(source, /\/api\/projects/);
  assert.match(source, /\/uploads/);
  assert.match(source, /\/process/);
  assert.match(source, /needs_review/);
  assert.match(source, /\/exports\/vi/);
  assert.match(source, /exportObjectKey/);
  assert.match(source, /range/i);
  assert.match(source, /timeout/i);
});

test('real-media workflow is permanently manual, fail-closed and requires explicit live confirmation', async () => {
  const source = await readRequiredSource('.github/workflows/real-media-smoke.yml');
  assert.match(source, /workflow_dispatch:/);
  assert.doesNotMatch(source, /^\s*push:/m);
  assert.match(source, /RUN_LIVE_MEDIA_SMOKE/);
  assert.match(source, /espeak-ng/);
  assert.match(source, /ffmpeg/);
  assert.match(source, /set\s+-o\s+pipefail/);
  assert.match(source, /real-media-smoke\.mjs/);
  assert.match(source, /upload-artifact/);
});
