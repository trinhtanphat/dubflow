import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const [wranglerText, packageText, indexSource, envSource, dubbingWorkflow, exportWorkflow, exportDispatcher, studioShell] = await Promise.all([
  read('wrangler.jsonc'),
  read('package.json'),
  read('worker/src/index.ts'),
  read('worker/src/env.ts'),
  read('worker/src/workflows/DubbingWorkflow.ts'),
  read('worker/src/workflows/ExportWorkflow.ts'),
  read('worker/src/workflows/exportPipeline.ts'),
  read('src/app/StudioShellBase.tsx'),
]);
const wrangler = JSON.parse(wranglerText);
const pkg = JSON.parse(packageText);

test('production config is Stream-based and contains no Container runtime binding or export', () => {
  assert.deepEqual(wrangler.stream, { binding: 'STREAM' });
  assert.equal(wrangler.containers, undefined);
  assert.equal(wrangler.durable_objects, undefined);
  assert.equal(wrangler.exports?.FfmpegContainer, undefined);
  assert.doesNotMatch(wranglerText, /FFMPEG_CONTAINER|FfmpegContainer|containers\/ffmpeg/);
});

test('production worker wiring and dependencies contain no hidden FFmpeg Container fallback', () => {
  assert.equal(pkg.dependencies?.['@cloudflare/containers'], undefined);
  assert.doesNotMatch(packageText, /containers\/ffmpeg|@cloudflare\/containers/);
  assert.doesNotMatch(indexSource, /ContainerProxy|FfmpegContainer|@cloudflare\/containers/);
  assert.doesNotMatch(envSource, /FFMPEG_CONTAINER|services\/media\/container|ContainerNamespaceLike/);
  for (const source of [dubbingWorkflow, exportWorkflow, exportDispatcher]) {
    assert.doesNotMatch(source, /ContainerMediaProcessor|FFMPEG_CONTAINER|services\/media\/container|ffmpeg-container/);
  }
});

test('Studio passes only the active dubbing job into UploadPanel for persisted progress and error feedback', () => {
  assert.match(
    studioShell,
    /<UploadPanel[\s\S]*job=\{cloudJob\?\.type === 'dubbing' \? cloudJob : null\}[\s\S]*onProcessStarted=\{onProcessStarted\}/,
  );
});

test('legacy FFmpeg Container implementation files are deleted', () => {
  for (const path of [
    'worker/src/services/media/container.ts',
    'worker/src/containers/FfmpegContainer.ts',
    'containers/ffmpeg/Dockerfile',
    'containers/ffmpeg/audio-chunks.mjs',
    'containers/ffmpeg/audio-chunks.test.mjs',
    'containers/ffmpeg/render-export.mjs',
    'containers/ffmpeg/render-export.test.mjs',
    'containers/ffmpeg/phase4d-render-contract.test.mjs',
    'containers/ffmpeg/server.mjs',
  ]) {
    assert.equal(existsSync(new URL(path, root)), false, `${path} must be deleted`);
  }
});
