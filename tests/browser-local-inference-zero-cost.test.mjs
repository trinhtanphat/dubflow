import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const packageSource = await source('package.json');

test('browser-local inference pins Transformers.js exactly', () => {
  assert.match(
    packageSource,
    /"@huggingface\/transformers"\s*:\s*"4\.2\.0"/,
    'zero-cost browser inference must exact-pin @huggingface/transformers 4.2.0',
  );
});

test('browser workers pin approved local Whisper and Marian models', async () => {
  const asr = await source('src/features/local-inference/browserAsr.worker.ts');
  const translation = await source('src/features/local-inference/browserTranslation.worker.ts');

  assert.match(asr, /onnx-community\/whisper-tiny\.en/);
  assert.match(asr, /2575352d61be1bf7225cf8f8b268a4678025fc58/);
  assert.match(asr, /automatic-speech-recognition/);
  assert.match(asr, /dtype\s*:\s*['"]q8['"]/);
  assert.match(translation, /Xenova\/opus-mt-en-vi/);
  assert.match(translation, /3f5f449333cbc7ecaa9eec16ee9e37682f036b8e/);
  assert.match(translation, /translation/);
  assert.match(translation, /dtype\s*:\s*['"]q8['"]/);
});

test('local coordinator is bounded and cannot fall back to server inference', async () => {
  const coordinator = await source('src/features/local-inference/localInferenceCoordinator.ts');
  assert.match(coordinator, /24\s*\*\s*1024\s*\*\s*1024|25_?165_?824/);
  assert.match(coordinator, /300_?000|300\s*\*\s*1000/);
  assert.match(coordinator, /500/);
  assert.match(coordinator, /2\s*\*\s*1024\s*\*\s*1024|2_?097_?152/);
  assert.match(coordinator, /client-inference\/vi/);
  assert.doesNotMatch(
    coordinator,
    /\/process|retranslate|voice\/capabilities|workers.?ai|deepgram|google|grok|xai|elevenlabs|sync.?labs|cloudflare\/stream|container/i,
  );
});

test('server commit boundary is generation-guarded, atomic, and truthful', async () => {
  const domain = await source('worker/src/domain/client-inference.ts');
  const persistence = await source('worker/src/db/client-inference.ts');
  const routes = await source('worker/src/routes/projects.ts');

  assert.match(domain, /sourceGeneration/);
  assert.match(domain, /sourceObjectKey/);
  assert.match(domain, /300_?000|300\s*\*\s*1000/);
  assert.match(domain, /500/);
  assert.match(domain, /browser-opus-mt/);
  assert.match(persistence, /\.batch\s*\(/);
  assert.match(persistence, /browser-local:/);
  assert.match(persistence, /browser-opus-mt/);
  assert.match(routes, /client-inference\/vi/);
});

test('old backend prepared-ASR contract is removed and paid inference stays disabled', async () => {
  assert.doesNotMatch(packageSource, /browser-asr-r2-chunks\.test\.mjs/);
  const wrangler = await source('wrangler.jsonc');
  assert.doesNotMatch(wrangler, /PAID_WORKERS_AI_ENABLED\s*"?\s*:\s*"true"/i);
  assert.doesNotMatch(wrangler, /PAID_DEEPGRAM_ASR_ENABLED\s*"?\s*:\s*"true"/i);
  assert.doesNotMatch(wrangler, /PAID_GOOGLE_TRANSLATE_ENABLED\s*"?\s*:\s*"true"/i);
});
