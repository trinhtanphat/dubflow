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

const [workflow, runner] = await Promise.all([
  source('../.github/workflows/production-media-fixture.yml'),
  source('../scripts/verify-production-browser-piper-fixture.mjs'),
]);

test('manual production fixture drives the deployed browser-local Piper lane without paid or deploy coupling', () => {
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /zero_charge_verified/);
  assert.match(workflow, /PRODUCTION_ZERO_CHARGE_VERIFIED/);
  assert.match(workflow, /verify-production-browser-piper-fixture\.mjs/);
  assert.doesNotMatch(workflow, /playwright|puppeteer|selenium|wrangler\s+deploy|PAID_[A-Z0-9_]*\s*=\s*true|CLOUDFLARE_STREAM|FFMPEG_CONTAINER/i);
});

test('browser fixture uses native CDP on the real production Studio path and waits for the zero-cost local action', () => {
  assert.match(runner, /--remote-debugging-port=0/);
  assert.match(runner, /new WebSocket\s*\(/);
  assert.match(runner, /Runtime\.enable/);
  assert.match(runner, /Network\.enable/);
  assert.match(runner, /\/projects\/\$\{encodeURIComponent\(projectId\)\}/);
  assert.match(runner, /Process locally \(zero-cost\)/);
  assert.match(runner, /if \(!button \|\| button\.disabled\) return null;/);
  assert.match(runner, /client-inference\/vi/);
  assert.match(runner, /exports\/vi/);
  assert.match(runner, /Page\.reload/);
  assert.match(runner, /PRODUCTION_MEDIA_OUTPUT_PATH/);
  assert.doesNotMatch(runner, /\/api\/voice\/capabilities|xai\/grok-tts|ElevenLabs|Deepgram|PAID_/i);
});

test('production fixture uses browser-local Whisper and Marian and never dispatches server processing', () => {
  assert.match(runner, /Process locally \(zero-cost\)/);
  assert.match(runner, /client-inference\/vi/);
  assert.match(runner, /browser-whisper/);
  assert.match(runner, /browser-opus-mt/);
  assert.match(runner, /onnx-community\/whisper-tiny\.en/);
  assert.match(runner, /Xenova\/opus-mt-en-vi/);
  assert.doesNotMatch(runner, /\/api\/projects\/\$\{encodeURIComponent\(projectId\)\}\/process/);
  assert.doesNotMatch(runner, /workers-ai-whisper-large-v3-turbo|ZERO_COST_ASR_PROVIDER/);
});

test('browser fixture records runtime network evidence and fails closed on forbidden inference traffic', () => {
  assert.match(runner, /Network\.requestWillBeSent/);
  assert.match(runner, /forbiddenInferenceRequests/);
  assert.match(runner, /serverInference/);
  assert.match(runner, /crossOriginMutation/);
  assert.match(runner, /networkEvidence/);
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
