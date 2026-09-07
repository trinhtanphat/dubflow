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

const [appSource, routeSource, translationStoreSource, exportSource, zeroContainerSource, objectKeySource] = await Promise.all([
  source('../worker/src/app.ts'),
  source('../worker/src/routes/client-voice.ts'),
  source('../worker/src/db/segment-translations.ts'),
  source('../worker/src/routes/export.ts'),
  source('../worker/src/workflows/zeroContainerExportPipeline.ts'),
  source('../worker/src/services/voice/object-key.ts'),
]);

test('zero-cost client PCM lane is mounted and bounded without paid-provider coupling', () => {
  assert.match(appSource, /createClientVoiceRoutes/);
  assert.match(routeSource, /X-DubFlow-Translation-Version/i);
  assert.match(routeSource, /X-DubFlow-PCM-Format/i);
  assert.match(routeSource, /24000|24_000/);
  assert.match(routeSource, /8\s*\*\s*1024\s*\*\s*1024/);
  assert.match(routeSource, /setVoiceResultForVersion/);
  assert.doesNotMatch(routeSource, /xai\/grok-tts|ElevenLabs|CLOUDFLARE_STREAM|FFMPEG_CONTAINER|wrangler\s+deploy/);
});

test('client PCM and zero-container export share one versioned target voice object key', () => {
  assert.match(objectKeySource, /targetVoiceObjectKey/);
  assert.match(objectKeySource, /projects\/\$\{projectId\}\/voices\/\$\{targetLanguage\}\/\$\{segmentId\}\/\$\{version\}\.pcm/);
  assert.match(routeSource, /targetVoiceObjectKey/);
  assert.match(zeroContainerSource, /targetVoiceObjectKey/);
});

test('translation voice persistence is optimistic and version-safe', () => {
  assert.match(translationStoreSource, /setVoiceResultForVersion/);
  assert.match(translationStoreSource, /version\s*=\s*\?/);
  assert.match(translationStoreSource, /TRANSLATION_VARIANT_CONFLICT/);
});

test('dubbed export can admit complete exact-version client PCM without weakening fallback checks', () => {
  assert.match(exportSource, /clientVoiceArtifactsComplete/);
  assert.match(exportSource, /targetVoiceObjectKey/);
  assert.match(exportSource, /voiceTargetError/);
  assert.match(exportSource, /voiceStatus\s*===\s*['"]completed['"]/);
  assert.match(exportSource, /dubbedObjectKey/);
});
