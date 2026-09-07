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

const [
  packageSource,
  browserPiperSource,
  pcmSource,
  clientVoiceApiSource,
  preloadSource,
  studioSource,
  mainSource,
] = await Promise.all([
  source('../package.json'),
  source('../src/features/voice/browserPiper.ts'),
  source('../src/features/voice/pcm.ts'),
  source('../src/features/voice/clientVoiceApi.ts'),
  source('../src/features/voice/clientVoicePreload.ts'),
  source('../src/app/StudioShell.tsx'),
  source('../src/main.tsx'),
]);

const pkg = JSON.parse(packageSource || '{}');

test('browser Piper preload is pinned, lazy, version-safe, and zero-cost', () => {
  assert.equal(pkg.dependencies?.['@mintplex-labs/piper-tts-web'], '1.0.5');
  assert.match(browserPiperSource, /import\(['"]@mintplex-labs\/piper-tts-web['"]\)/);
  assert.match(browserPiperSource, /vi_VN-vais1000-medium/);
  assert.match(pcmSource, /24_000|24000/);
  assert.match(clientVoiceApiSource, /X-DubFlow-PCM-Format/i);
  assert.match(clientVoiceApiSource, /X-DubFlow-PCM-Sample-Rate/i);
  assert.match(clientVoiceApiSource, /X-DubFlow-Translation-Version/i);
  assert.match(preloadSource, /getTranslationVariants/);
  assert.match(preloadSource, /uploadClientVoicePcm/);
  assert.match(studioSource, /ensureVietnameseClientVoiceCache/);
  assert.doesNotMatch(mainSource, /@mintplex-labs\/piper-tts-web/);
  assert.doesNotMatch(`${browserPiperSource}\n${preloadSource}`, /ElevenLabs|grok-tts|PAID_GROK_TTS_ENABLED/);
});
