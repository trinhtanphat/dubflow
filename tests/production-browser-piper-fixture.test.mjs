import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  try {
    return await readFile(new URL(path, import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

const [workflow, runner, packageSource] = await Promise.all([
  source('../.github/workflows/production-media-fixture.yml'),
  source('../scripts/verify-production-browser-piper-fixture.mjs'),
  source('../package.json'),
]);

test('manual production fixture drives the deployed browser Piper lane without paid or deploy coupling', () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /verify-production-browser-piper-fixture\.mjs/);
  assert.doesNotMatch(workflow, /playwright|puppeteer|selenium|wrangler\s+deploy|PAID_[A-Z0-9_]*\s*=\s*true|CLOUDFLARE_STREAM|FFMPEG_CONTAINER/i);
  assert.match(packageSource, /production-browser-piper-fixture\.test\.mjs/);
});

test('browser fixture uses native CDP on the real production Studio path and proves reload durability', () => {
  assert.match(runner, /--remote-debugging-port=0/);
  assert.match(runner, /new WebSocket\s*\(/);
  assert.match(runner, /Runtime\.enable/);
  assert.match(runner, /Network\.enable/);
  assert.match(runner, /\/projects\/\$\{encodeURIComponent\(projectId\)\}/);
  assert.match(runner, /data-testid=["']export-current-language["']/);
  assert.match(runner, /exports\/vi/);
  assert.match(runner, /Page\.reload/);
  assert.match(runner, /PRODUCTION_MEDIA_OUTPUT_PATH/);
  assert.doesNotMatch(runner, /\/api\/voice\/capabilities|xai\/grok-tts|ElevenLabs|Deepgram|PAID_/i);
});
