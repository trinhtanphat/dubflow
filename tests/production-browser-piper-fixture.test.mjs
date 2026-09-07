import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProductionBrowserPiperFixture } from '../scripts/verify-production-browser-piper-fixture.mjs';

async function source(filePath) {
  try {
    return await readFile(new URL(filePath, import.meta.url), 'utf8');
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
  assert.match(workflow, /zero_charge_verified/);
  assert.match(workflow, /PRODUCTION_ZERO_CHARGE_VERIFIED/);
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

test('browser fixture rejects an unverified zero-charge run before any production request', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dubflow-zero-charge-test-'));
  const fixturePath = path.join(dir, 'fixture.mp4');
  const outputPath = path.join(dir, 'output.mp4');
  await writeFile(fixturePath, Buffer.from('fixture'));
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    throw new Error('production request should not be reached');
  };

  try {
    await assert.rejects(
      runProductionBrowserPiperFixture({
        fetchImpl,
        fixturePath,
        outputPath,
        zeroChargeVerified: 'false',
      }),
      /ZERO_CHARGE_RUNTIME_UNVERIFIED/,
    );
    assert.equal(requests, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
