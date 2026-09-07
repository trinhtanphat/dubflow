import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

test('long-form ASR is prepared in a browser worker and stored as generation-bound R2 WAV chunks', async () => {
  const prep = await source('src/features/upload/sourceAudioPrep.ts');
  const prepWorker = await source('src/features/upload/sourceAudioPrep.worker.ts');
  const api = await source('src/features/upload/preparedAsrApi.ts');
  const flow = await source('src/features/upload/cloudUploadFlow.ts');
  const uploads = await source('worker/src/routes/uploads.ts');
  const uploadService = await source('worker/src/services/uploads.ts');
  const r2Source = await source('worker/src/services/media/r2-source.ts');
  const pipeline = await source('worker/src/workflows/pipeline.ts');
  const wrangler = await source('wrangler.jsonc');

  assert.match(prep, /new Worker\s*\(/);
  assert.match(prep, /300_?000|300\s*\*\s*1000/);
  assert.match(prep, /prepare.*chunk/i);
  assert.doesNotMatch(prep, /Promise\.all\s*\(/);

  assert.match(prepWorker, /BlobSource/);
  assert.match(prepWorker, /Conversion/);
  assert.match(prepWorker, /WavOutputFormat/);
  assert.match(prepWorker, /BufferTarget/);
  assert.match(prepWorker, /sampleRate\s*:\s*16_?000|sampleRate\s*:\s*16000/);
  assert.match(prepWorker, /numberOfChannels\s*:\s*1|channels\s*:\s*1/);
  assert.match(prepWorker, /s16/i);
  assert.match(prepWorker, /discard/i);

  assert.match(api, /uploads\/asr\/chunks/);
  assert.match(api, /uploads\/asr\/complete/);
  assert.match(flow, /getProject/);
  assert.match(flow, /prepare/i);
  assert.match(flow, /startProcessing/);

  assert.match(uploads, /asr\/chunks/);
  assert.match(uploads, /asr\/complete/);
  assert.match(uploadService, /sourceGeneration/);
  assert.match(uploadService, /manifest\.json/);
  assert.match(uploadService, /chunk-\$\{|chunk-/);
  assert.match(uploadService, /RIFF/);
  assert.match(uploadService, /WAVE/);

  assert.match(r2Source, /manifest\.json/);
  assert.match(r2Source, /sourceGeneration/);
  assert.match(r2Source, /readPrepared|prepared/i);
  assert.match(pipeline, /prepared/i);
  assert.match(pipeline, /offsetMs/);

  assert.doesNotMatch(wrangler, /PAID_WORKERS_AI_ENABLED\s*"?\s*:\s*"true"/i);
  assert.doesNotMatch(`${prep}\n${prepWorker}\n${pipeline}`, /cloudflare\/stream|FFMPEG_CONTAINER|nodeav|@mediabunny\/server/i);
});
