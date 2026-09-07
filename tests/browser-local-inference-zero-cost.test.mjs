import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const packageSource = await readFile(new URL('../package.json', import.meta.url), 'utf8');

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('browser-local inference pins Transformers.js exactly', () => {
  assert.match(
    packageSource,
    /"@huggingface\/transformers"\s*:\s*"4\.2\.0"/,
    'zero-cost browser inference must exact-pin @huggingface/transformers 4.2.0',
  );
});

test('browser-local workers pin the approved Whisper and Marian revisions', async () => {
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
