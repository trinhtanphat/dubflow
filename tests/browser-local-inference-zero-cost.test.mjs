import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  try {
    return await readFile(new URL(`../${path}`, import.meta.url), 'utf8');
  } catch {
    return '';
  }
}

const packageSource = await source('package.json');

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

test('Whisper worker performs real local inference with bounded WebGPU-to-WASM init fallback', async () => {
  const asr = await source('src/features/local-inference/browserAsr.worker.ts');

  assert.match(asr, /import\s*\(\s*['"]@huggingface\/transformers['"]\s*\)/);
  assert.match(asr, /pipeline\s*\(/);
  assert.match(asr, /device\s*:\s*['"]webgpu['"]/);
  assert.match(asr, /device\s*:\s*['"]wasm['"]/);
  assert.match(asr, /return_timestamps\s*:\s*true/);
  assert.match(asr, /Float32Array/);
  assert.match(asr, /16_?000/);
  assert.match(asr, /\.dispose\s*\(/);
  assert.match(asr, /shutdown/);
  assert.match(asr, /type\s*:\s*['"]result['"]/);
  assert.match(asr, /startMs/);
  assert.match(asr, /endMs/);
  assert.doesNotMatch(asr, /\bfetch\s*\(/);
});

test('Marian worker performs sequential EN-to-VI local translation and disposes explicitly', async () => {
  const translation = await source('src/features/local-inference/browserTranslation.worker.ts');

  assert.match(translation, /import\s*\(\s*['"]@huggingface\/transformers['"]\s*\)/);
  assert.match(translation, /pipeline\s*\(/);
  assert.match(translation, /device\s*:\s*['"]webgpu['"]/);
  assert.match(translation, /device\s*:\s*['"]wasm['"]/);
  assert.match(translation, /translation_text/);
  assert.match(translation, /\.dispose\s*\(/);
  assert.match(translation, /shutdown/);
  assert.match(translation, /type\s*:\s*['"]result['"]/);
  assert.doesNotMatch(translation, /\bfetch\s*\(/);
});

test('local coordinator is browser-only and has no metered or server-inference fallback', async () => {
  const coordinator = await source('src/features/local-inference/localInferenceCoordinator.ts');

  assert.match(coordinator, /browserAsr\.worker\.ts/);
  assert.match(coordinator, /browserTranslation\.worker\.ts/);
  assert.match(coordinator, /client-inference\/vi/);
  assert.doesNotMatch(
    coordinator,
    /\/process\b|retranslate|voice\/capabilities|Workers AI|workers-ai|Deepgram|Google(?: Cloud)? Translate|Grok|xAI|ElevenLabs|Sync Labs|Cloudflare Stream|FFMPEG_CONTAINER|Containers?/i,
  );
});

test('Studio exposes an eligible zero-cost action, prepares canonical Piper PCM and starts standard VI export', async () => {
  const studio = await source('src/app/StudioShell.tsx');
  assert.match(studio, /runBrowserLocalInference/);
  assert.match(studio, /Process locally \(zero-cost\)/);
  assert.match(studio, /prepareVietnameseClientVoice/);
  assert.match(studio, /Preparing source/i);
  assert.match(studio, /Transcribing locally/i);
  assert.match(studio, /Translating locally/i);
  assert.match(studio, /localInferenceEligible/);
  assert.match(studio, /\{localInferenceEligible\s*&&/);
  assert.match(studio, /setLocalInferenceStatus\(\s*['"]Exporting['"]\s*\)/);
  assert.match(
    studio,
    /startLanguageExport\(\s*projectId\s*,\s*['"]vi['"]\s*,\s*['"]dubbed['"]\s*,\s*['"]dubbed_only['"]\s*,\s*['"]standard['"]\s*\)/s,
  );
});

test('server local-inference contract locks the single new PUT route, limits, provenance and project-unique speaker', async () => {
  const domain = await source('worker/src/domain/client-inference.ts');
  const routes = await source('worker/src/routes/projects.ts');

  assert.match(routes, /put\s*\(\s*['"]\/:id\/client-inference\/vi['"]/i);
  assert.doesNotMatch(
    routes,
    /get\s*\(\s*['"]\/:id\/client-inference\/vi['"]/i,
    'approved design adds exactly one client-inference route: PUT; resumability must reuse an existing authenticated read surface',
  );
  assert.match(domain, /browser-whisper/);
  assert.match(domain, /onnx-community\/whisper-tiny\.en/);
  assert.match(domain, /2575352d61be1bf7225cf8f8b268a4678025fc58/);
  assert.match(domain, /browser-opus-mt/);
  assert.match(domain, /Xenova\/opus-mt-en-vi/);
  assert.match(domain, /3f5f449333cbc7ecaa9eec16ee9e37682f036b8e/);

  assert.match(domain, /24\s*\*\s*1024\s*\*\s*1024/);
  assert.match(domain, /300_?000|300\s*\*\s*1000/);
  assert.match(domain, /\b500\b/);
  assert.match(domain, /2\s*\*\s*1024\s*\*\s*1024/);
  assert.match(domain, /1_?000|1000/);

  assert.match(domain, /browser-local:\$\{projectId\}:speaker-1/);
  assert.doesNotMatch(domain, /browser-local-speaker-1/);
});

test('atomic durable commit records exact source-bound resumability provenance', async () => {
  const persistence = await source('worker/src/db/client-inference.ts');
  assert.match(persistence, /(?:INSERT|REPLACE).*browser_local_inference_state/is);
  assert.match(persistence, /expectedSourceGeneration/);
  assert.match(persistence, /expectedSourceObjectKey/);
  assert.match(persistence, /LOCAL_INFERENCE_ASR\.model/);
  assert.match(persistence, /LOCAL_INFERENCE_ASR\.revision/);
  assert.match(persistence, /LOCAL_INFERENCE_TRANSLATION\.model/);
  assert.match(persistence, /LOCAL_INFERENCE_TRANSLATION\.revision/);
});

test('browser-local translation provenance is admitted only by a new append-only migration', async () => {
  const migration = await source('migrations/0013_browser_local_translation_engine.sql');

  assert.ok(migration.length > 0, '0013 browser-local translation-engine migration must exist');
  assert.match(migration, /browser-opus-mt/);
  assert.match(migration, /CREATE TABLE\s+segments/i);
  assert.match(migration, /idx_segments_project_start/);
  assert.match(migration, /idx_segments_project_split_parent/);
  assert.match(migration, /CREATE TABLE\s+browser_local_inference_state/i);
  assert.match(migration, /invalidate_browser_local_inference_state_on_source_change/);
  assert.doesNotMatch(migration, /ALTER\s+TABLE\s+.*0012|UPDATE\s+.*0012/i);
});

test('superseded backend-ASR chunk contract is absent from source verification', () => {
  assert.doesNotMatch(packageSource, /browser-asr-r2-chunks\.test\.mjs/);
});
