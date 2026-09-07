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
  panelSource,
  studioSource,
  preloadSource,
  workerSource,
  workerClientSource,
  apiSource,
  pcmSource,
  viteConfigSource,
] = await Promise.all([
  source('../package.json'),
  source('../src/features/export/BatchExportPanel.tsx'),
  source('../src/app/StudioShell.tsx'),
  source('../src/features/voice/clientVoicePreload.ts'),
  source('../src/features/voice/browserPiper.worker.ts'),
  source('../src/features/voice/browserPiperClient.ts'),
  source('../src/features/voice/clientVoiceApi.ts'),
  source('../src/features/voice/clientPcm.ts'),
  source('../vite.config.ts'),
]);

test('browser Piper zero-cost lane pins the qualified dependency and voice', () => {
  assert.match(packageSource, /"@mintplex-labs\/piper-tts-web"\s*:\s*"1\.0\.5"/);
  assert.match(workerSource, /vi_VN-vais1000-medium/);
  assert.match(workerSource, /@mintplex-labs\/piper-tts-web/);
});

test('browser Piper stays lazy and converts to the backend PCM contract', () => {
  assert.match(workerClientSource, /new\s+Worker\s*\(\s*new\s+URL\([^)]*browserPiper\.worker\.ts/);
  assert.match(workerClientSource, /type:\s*['"]module['"]/);
  assert.match(pcmSource, /24_000|24000/);
  assert.match(pcmSource, /8\s*\*\s*1024\s*\*\s*1024/);
  assert.match(apiSource, /X-DubFlow-PCM-Format/);
  assert.match(apiSource, /X-DubFlow-Translation-Version/);
});

test('browser Piper initializes one reusable inference session before declaring ready', () => {
  assert.match(workerSource, /TtsSession\.create\s*\(/);
  assert.match(workerSource, /let\s+session\s*:/);
  assert.match(workerSource, /session\.predict\s*\(/);
  assert.doesNotMatch(workerSource, /tts\.download\s*\(/);
});

test('browser Piper worker bundle uses ES modules so Vite can code-split Piper runtime dependencies', () => {
  assert.match(viteConfigSource, /worker\s*:\s*\{[\s\S]*?format\s*:\s*['"]es['"]/);
});

test('Studio preloads exact-version Vietnamese voices before export', () => {
  assert.match(preloadSource, /preloadVietnameseVoices/);
  assert.match(preloadSource, /voiceStatus/);
  assert.match(preloadSource, /dubbedObjectKey/);
  assert.match(studioSource, /preloadVietnameseVoices/);
  assert.match(studioSource, /clientVoiceStatus/);
});

test('Studio admits an exact Vietnamese voice cache before requiring Piper primitives', () => {
  assert.match(studioSource, /isExactVietnameseVoiceCached/);
  assert.match(studioSource, /clientVoiceCached/);
  const prepareStart = studioSource.indexOf('const prepareVietnameseClientVoice');
  const prepareEnd = studioSource.indexOf('const exportCurrent', prepareStart);
  assert.ok(prepareStart >= 0 && prepareEnd > prepareStart);
  const prepareSource = studioSource.slice(prepareStart, prepareEnd);
  const fetchIndex = prepareSource.indexOf("getTranslationVariants(projectId, 'vi')");
  const piperIndex = prepareSource.indexOf('browserPiperAvailable()');
  assert.ok(fetchIndex >= 0 && piperIndex >= 0 && fetchIndex < piperIndex);
});

test('Piper initialization failure makes the mounted Studio client lane unavailable', () => {
  assert.match(workerClientSource, /class\s+BrowserPiperError\s+extends\s+Error/);
  assert.match(studioSource, /BrowserPiperError/);
  assert.match(studioSource, /PIPER_INIT_FAILED/);
  assert.match(studioSource, /setClientVoiceState\(\s*['"]unavailable['"]\s*\)/);
});

test('export presentation can admit the Vietnamese client lane without broadening provider admission', () => {
  assert.match(panelSource, /clientVoiceAvailable/);
  assert.match(panelSource, /targetLanguage\s*===\s*['"]vi['"]/);
  assert.match(panelSource, /dubbedAvailability/);
});

test('browser zero-cost lane has no paid, Stream, Container, or deploy coupling', () => {
  const combined = [preloadSource, workerSource, workerClientSource, apiSource, pcmSource].join('\n');
  assert.doesNotMatch(combined, /xai\/grok-tts|ElevenLabs|AI Gateway|CLOUDFLARE_STREAM|FFMPEG_CONTAINER|wrangler\s+deploy/i);
});
