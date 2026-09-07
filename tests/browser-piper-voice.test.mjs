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
  clientPcmSource,
  clientPiperSource,
  voiceApiSource,
  studioSource,
  batchPanelSource,
] = await Promise.all([
  source('../package.json'),
  source('../src/features/voice/clientPcm.ts'),
  source('../src/features/voice/clientPiperVoice.ts'),
  source('../src/features/voice/voiceApi.ts'),
  source('../src/app/StudioShell.tsx'),
  source('../src/features/export/BatchExportPanel.tsx'),
]);

const packageJson = JSON.parse(packageSource);

test('browser Piper dependency is exact and the Vietnamese adapter stays browser-only', () => {
  assert.equal(packageJson.dependencies?.['@mintplex-labs/piper-tts-web'], '1.0.5');
  assert.match(clientPiperSource, /PIPER_VI_VOICE_ID\s*=\s*['"]vi_VN-vais1000-medium['"]/);
  assert.match(clientPiperSource, /import\(['"]@mintplex-labs\/piper-tts-web['"]\)/);
  assert.doesNotMatch(clientPiperSource, /^import\s+.*@mintplex-labs\/piper-tts-web/m);
  assert.doesNotMatch(clientPiperSource, /fetchVoicePreview|\/api\/voice\/preview|xai\/grok-tts|ElevenLabs|AI Gateway/i);
});

test('Piper WAV is converted to the exact backend PCM contract', () => {
  assert.match(clientPcmSource, /CLIENT_PCM_SAMPLE_RATE\s*=\s*24_?000/);
  assert.match(clientPcmSource, /wavToClientPcm/);
  assert.match(clientPcmSource, /RIFF/);
  assert.match(clientPcmSource, /WAVE/);
  assert.match(clientPcmSource, /16/);
  assert.match(clientPcmSource, /little|Int16|setInt16/i);
});

test('client voice API uploads exact-version 24 kHz mono s16le bytes', () => {
  assert.match(voiceApiSource, /uploadClientVoicePcm/);
  assert.match(voiceApiSource, /voice-pcm/);
  assert.match(voiceApiSource, /X-DubFlow-PCM-Format/);
  assert.match(voiceApiSource, /X-DubFlow-PCM-Sample-Rate/);
  assert.match(voiceApiSource, /X-DubFlow-PCM-Channels/);
  assert.match(voiceApiSource, /X-DubFlow-Translation-Version/);
  assert.match(voiceApiSource, /application\/octet-stream/);
});

test('Vietnamese cache preload uses fresh variants and skips exact current artifacts', () => {
  assert.match(clientPiperSource, /prepareVietnameseClientVoiceCache/);
  assert.match(clientPiperSource, /getTranslationVariants\([^)]*['"]vi['"]/s);
  assert.match(clientPiperSource, /projects\/\$\{projectId\}\/voices\/vi\/\$\{[^}]+\}\/\$\{[^}]+\}\.pcm/);
  assert.match(clientPiperSource, /voiceStatus\s*===\s*['"]completed['"]/);
  assert.match(clientPiperSource, /dubbedObjectKey/);
  assert.match(clientPiperSource, /uploadClientVoicePcm/);
});

test('Studio preloads local Vietnamese voice only before dubbed_only export', () => {
  assert.match(studioSource, /prepareVietnameseClientVoiceCache/);
  assert.match(studioSource, /dubbed_only/);
  assert.match(studioSource, /startLanguageExport/);
  assert.match(studioSource, /startBatchExport/);
  assert.match(studioSource, /isLocalPiperSupported/);
});

test('local Vietnamese capability does not weaken non-Vietnamese provider admission', () => {
  assert.match(batchPanelSource, /localVietnameseVoiceAvailable/);
  assert.match(batchPanelSource, /targetLanguage\s*===\s*['"]vi['"]/);
  assert.match(batchPanelSource, /capabilities\?\.configured/);
  assert.match(batchPanelSource, /languages\.includes\(targetLanguage\)/);
});
