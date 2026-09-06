import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

const [
  route,
  pipeline,
  media,
  render,
  api,
  panel,
  studio,
  wrangler,
  status,
] = await Promise.all([
  source('worker/src/routes/export.ts'),
  source('worker/src/workflows/exportPipeline.ts'),
  source('worker/src/services/media/container.ts'),
  source('containers/ffmpeg/render-export.mjs'),
  source('src/features/export/batchExportApi.ts'),
  source('src/features/export/BatchExportPanel.tsx'),
  source('src/app/StudioShell.tsx'),
  source('wrangler.jsonc'),
  source('docs/deployment-status.md'),
]);

test('Phase 4D keeps source_mix as the default and preserve-background admission fail-closed', () => {
  assert.match(route, /source_mix/);
  assert.match(route, /preserve_background/);
  assert.match(route, /STEM_SEPARATION_UNAVAILABLE/);
  assert.match(route, /export-capabilities/);
  assert.match(api, /SeparationMode\s*=\s*'source_mix'\s*\|\s*'preserve_background'/);
  assert.match(api, /separationMode:\s*SeparationMode\s*=\s*'source_mix'/);
  assert.match(api, /output\s*===\s*'dubbed'/);
});

test('Phase 4D Studio loads project capability and exposes an unavailable-safe separation control', () => {
  assert.match(api, /getExportCapabilities/);
  assert.match(studio, /getExportCapabilities\(projectId\)/);
  assert.match(studio, /useState<SeparationMode>\('source_mix'\)/);
  assert.match(studio, /separationMode=\{separationMode\}/);
  assert.match(panel, /Source mix/);
  assert.match(panel, /Preserve background\/music/);
  assert.match(panel, /disabled=\{!preserveAvailable\}/);
});

test('Phase 4D reuses canonical project stems, meters provider work, and renders over background while preserving source video', () => {
  assert.match(pipeline, /stem_separation_audio_second/);
  assert.match(pipeline, /backgroundObjectKey/);
  assert.match(pipeline, /stem-separation/);
  assert.match(media, /stems\/\$\{sourceRevision\}/);
  assert.match(media, /background\.wav/);
  assert.match(render, /backgroundPath/);
  assert.match(render, /'-map',\s*'0:v:0\?'/);
});

test('Phase 4D production config retains the canonical account, public domain, and FFmpeg container binding', () => {
  assert.match(wrangler, /50afb4fd3c4c7a1f3e1bdb7f22d4af7f/);
  assert.match(wrangler, /yupvox\.qs3d\.site/);
  assert.match(wrangler, /FFMPEG_CONTAINER/);
  assert.match(wrangler, /containers\/ffmpeg\/Dockerfile/);
});

test('Phase 4D documentation separates source qualification from runtime qualification', () => {
  assert.match(status, /Phase 4D/);
  assert.match(status, /source[- ]qualified|source\/CI qualified/i);
  assert.match(status, /UNQUALIFIED/);
  assert.match(status, /real separation fixture/i);
});
